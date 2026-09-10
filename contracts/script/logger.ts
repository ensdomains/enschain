import { writeFileSync } from "node:fs";
import {
  red,
  green,
  yellow,
  blue,
  cyan,
  magenta,
  bold,
  dim,
} from "yoctocolors";

export { red, green, yellow, blue, cyan, magenta, bold, dim };

export interface LoggerOptions {
  infoLogFile?: string;
  errorLogFile?: string;
  enableFileLogging?: boolean;
}

/**
 * Base logger class with optional file logging and colored console output.
 * Designed to be extended by domain-specific loggers.
 */
export class Logger {
  protected options: LoggerOptions;
  private fileLoggingDisabledReason?: string;

  constructor(options: LoggerOptions = {}) {
    this.options = { enableFileLogging: false, ...options };
  }

  // ============================================================
  // Internal / Protected Methods
  // ============================================================

  /**
   * Write a message to the appropriate log file
   */
  protected _writeToFile(
    type: "info" | "error",
    message: string,
    prefix = "",
  ): void {
    if (!this.options.enableFileLogging) return;

    const file =
      type === "info" ? this.options.infoLogFile : this.options.errorLogFile;
    if (!file) return;

    const timestamp = new Date().toISOString();
    if (this.fileLoggingDisabledReason) return;

    try {
      writeFileSync(file, `[${timestamp}]${prefix} ${message}\n`, {
        flag: "a",
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.fileLoggingDisabledReason = errorMessage;
      console.warn(
        yellow(
          `WARNING: file logging disabled after write failure: ${errorMessage}`,
        ),
      );
    }
  }

  /**
   * Strip ANSI color codes from a string
   */
  private _stripAnsi(str: string): string {
    return str.replace(
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      "",
    );
  }

  /**
   * Protected primitive for derived classes to write to console and file
   * @param consoleMsg - Message to write to console (can include ANSI codes)
   * @param fileMsg - Message to write to file (plain text, defaults to consoleMsg with ANSI stripped)
   */
  protected raw(consoleMsg: string, fileMsg?: string): void {
    console.log(consoleMsg);
    this._writeToFile("info", fileMsg ?? this._stripAnsi(consoleMsg));
  }

  /**
   * Protected primitive for derived classes to write errors to console and file
   * @param consoleMsg - Message to write to console (can include ANSI codes)
   * @param fileMsg - Message to write to file (plain text, defaults to consoleMsg with ANSI stripped)
   */
  protected rawError(consoleMsg: string, fileMsg?: string): void {
    console.error(consoleMsg);
    this._writeToFile(
      "error",
      fileMsg ?? this._stripAnsi(consoleMsg),
      " ERROR:",
    );
  }

  /**
   * Protected primitive for derived classes to write warnings to console and file
   * @param consoleMsg - Message to write to console (can include ANSI codes)
   * @param fileMsg - Message to write to file (plain text, defaults to consoleMsg with ANSI stripped)
   */
  protected rawWarn(consoleMsg: string, fileMsg?: string): void {
    console.warn(consoleMsg);
    this._writeToFile("info", fileMsg ?? this._stripAnsi(consoleMsg));
  }

  // ============================================================
  // Public Logging Methods
  // ============================================================

  /**
   * Log an informational message
   */
  info(message: string): void {
    this.raw(message);
  }

  /**
   * Log an error message
   */
  error(message: string): void {
    this.rawError(red(`ERROR: ${message}`), message);
  }

  /**
   * Log a success message
   */
  success(message: string): void {
    this.raw(green(`✓ ${message}`), `✓ ${message}`);
  }

  /**
   * Log a warning message
   */
  warning(message: string): void {
    this.rawWarn(yellow(`WARNING: ${message}`), `WARNING: ${message}`);
  }

  // ============================================================
  // Formatting Methods
  // ============================================================

  /**
   * Log a header/section title
   */
  header(message: string): void {
    this.raw(
      "\n" + bold(cyan(`=== ${message} ===`)) + "\n",
      `\n=== ${message} ===\n`,
    );
  }

  /**
   * Log a divider line
   */
  divider(): void {
    this.raw(dim("─".repeat(60)), "─".repeat(60));
  }

  /**
   * Log a configuration item
   */
  config(key: string, value: string | number | boolean): void {
    const valueStr = String(value);
    this.raw(cyan(`${key}: `) + valueStr, `${key}: ${valueStr}`);
  }

  // ============================================================
  // Utility Methods
  // ============================================================

  /**
   * Log a cleanup operation result
   */
  cleanup(file: string, success: boolean): void {
    if (success) {
      this.raw(green(`  → Deleted ${file}`), `  → Deleted ${file}`);
    } else {
      this.rawWarn(
        yellow(`  → Could not delete ${file}`),
        `  → Could not delete ${file}`,
      );
    }
  }
}
