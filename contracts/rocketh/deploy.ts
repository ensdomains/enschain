import { setupDeployScripts } from "rocketh";
import {
  type Accounts,
  type Data,
  type Extensions,
  extensions,
} from "./config.js";

const { deployScript } = setupDeployScripts<Extensions, Accounts, Data>(
  extensions,
);

export { deployScript as execute };
