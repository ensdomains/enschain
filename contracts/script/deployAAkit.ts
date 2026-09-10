import { spawn } from "child_process";
import { createPublicClient, http } from "viem";
import { getChainId } from "viem/actions";
import path from "path";

const colors = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  reset: "\x1b[0m",
};

function log(message: string, color: keyof typeof colors = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function checkDevnetRunning(): Promise<boolean> {
  try {
    const l1Client = createPublicClient({
      transport: http("http://localhost:8545"),
    });

    const l2Client = createPublicClient({
      transport: http("http://localhost:8546"),
    });

    // Try to get the chain ID from both chains
    const [l1ChainId, l2ChainId] = await Promise.all([
      getChainId(l1Client),
      getChainId(l2Client),
    ]);

    log(
      `✓ L1 devnet running on localhost:8545 (Chain ID: ${l1ChainId})`,
      "green",
    );
    log(
      `✓ L2 devnet running on localhost:8546 (Chain ID: ${l2ChainId})`,
      "green",
    );

    return true;
  } catch (error) {
    return false;
  }
}

async function checkDockerRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const dockerCheck = spawn("docker", ["info"], {
      stdio: "ignore",
    });

    dockerCheck.on("close", (code) => {
      resolve(code === 0);
    });

    dockerCheck.on("error", () => {
      resolve(false);
    });
  });
}

async function checkService(url: string, name: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    if (response.ok) {
      log(`✓ ${name} is running at ${url}`, "green");
      return true;
    } else {
      log(`✗ ${name} returned status ${response.status} at ${url}`, "red");
      return false;
    }
  } catch (error) {
    log(`✗ ${name} is not accessible at ${url}`, "red");
    return false;
  }
}

async function verifyServices(): Promise<void> {
  log("\nVerifying AA Kit services...", "blue");

  const services = [
    { name: "Alto L1 (bundler)", url: "http://localhost:4337/health" },
    { name: "Alto L2 (bundler)", url: "http://localhost:4338/health" },
    { name: "Mock Paymaster L1", url: "http://localhost:3000/ping" },
    { name: "Mock Paymaster L2", url: "http://localhost:3001/ping" },
  ];

  const results = await Promise.all(
    services.map((service) => checkService(service.url, service.name)),
  );

  const allRunning = results.every((result) => result);

  if (allRunning) {
    log("\n✓ All services are running successfully!", "green");
    log("\nYour AA Kit infrastructure is ready:", "green");
    log("  - Alto L1 (bundler): http://localhost:4337", "green");
    log("  - Alto L2 (bundler): http://localhost:4338", "green");
    log("  - Mock Paymaster L1: http://localhost:3000", "green");
    log("  - Mock Paymaster L2: http://localhost:3001", "green");
    log("\nPress Ctrl+C to stop all services", "yellow");
  } else {
    log("\n✗ Some services failed to start", "red");
    log("Check the logs with: docker compose --profile local logs", "yellow");
  }
}

async function runDockerCompose(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "../..");

  log("\nStarting AA Kit services with local profile...", "blue");

  // Start services in detached mode with timeout
  const dockerCompose = spawn(
    "docker",
    [
      "compose",
      "--profile",
      "local",
      "up",
      "-d",
      "--remove-orphans",
      "--timeout",
      "120",
    ],
    {
      cwd: projectRoot,
      stdio: "inherit",
    },
  );

  await new Promise<void>((resolve, reject) => {
    dockerCompose.on("error", (error) => {
      log(`Failed to start docker compose: ${error.message}`, "red");
      reject(error);
    });

    dockerCompose.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Docker compose exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });

  // Wait for services to be ready (with timeout check)
  log("\nWaiting for services to be ready...", "yellow");

  // Check if deployers are done (max 3 minutes)
  let attempts = 0;
  const maxAttempts = 36; // 3 minutes with 5-second intervals

  while (attempts < maxAttempts) {
    const { stdout } = await new Promise<{ stdout: string }>((resolve) => {
      const process = spawn(
        "docker",
        [
          "ps",
          "--filter",
          "name=contract-deployer",
          "--filter",
          "status=running",
          "--format",
          "{{.Names}}",
        ],
        {
          cwd: projectRoot,
        },
      );

      let stdout = "";
      process.stdout.on("data", (data) => (stdout += data.toString()));
      process.on("close", () => resolve({ stdout }));
    });

    if (!stdout.trim()) {
      log("Contract deployers completed", "green");
      break;
    }

    attempts++;
    if (attempts % 6 === 0) {
      // Every 30 seconds
      log(
        `Still waiting for contract deployers... (${attempts * 5}s)`,
        "yellow",
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  if (attempts >= maxAttempts) {
    log(
      "⚠️  Contract deployers are taking longer than expected, but continuing to check services...",
      "yellow",
    );
  }

  // Wait a bit for services to fully start
  log("\nGiving services time to fully initialize...", "yellow");
  await new Promise((resolve) => setTimeout(resolve, 10000)); // 10 seconds

  // Verify services are running
  await verifyServices();
}

async function main() {
  log("AA Kit Deployment Script", "blue");
  log("=======================\n", "blue");

  // Check if Docker is running
  log("Checking Docker daemon...", "yellow");
  const dockerRunning = await checkDockerRunning();

  if (!dockerRunning) {
    log("✗ Docker is not running!", "red");
    log(
      "Please start Docker Desktop or the Docker daemon and try again.",
      "red",
    );
    process.exit(1);
  }
  log("✓ Docker is running", "green");

  // Check if devnet is running
  log("\nChecking local devnet...", "yellow");
  const devnetRunning = await checkDevnetRunning();

  if (!devnetRunning) {
    log("✗ Local devnet is not running!", "red");
    log("\nPlease start the devnet first by running:", "yellow");
    log("  bun run devnet", "yellow");
    log("\nThen run this script again in a new terminal.", "yellow");
    process.exit(1);
  }

  // Run docker compose
  try {
    await runDockerCompose();

    // Handle shutdown
    process.on("SIGINT", async () => {
      log("\n\nStopping AA Kit services...", "yellow");

      const stopProcess = spawn(
        "docker",
        ["compose", "--profile", "local", "down"],
        {
          cwd: path.resolve(__dirname, "../.."),
          stdio: "inherit",
        },
      );

      stopProcess.on("close", () => {
        log("AA Kit services stopped", "yellow");
        process.exit(0);
      });
    });

    // Keep the script running
    setInterval(() => {}, 1000);
    await new Promise<void>(() => {});
  } catch (error) {
    log(`\nError: ${error}`, "red");
    process.exit(1);
  }
}

main().catch((error) => {
  log(`Unexpected error: ${error}`, "red");
  process.exit(1);
});
