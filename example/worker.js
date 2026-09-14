// The Worker entry file a deployment ships: build doorman from its config and export it.
// A consumer imports from the package instead: `import {createDoorman} from "doorman";`
import {createDoorman} from "../src/index.js";
import config from "./doorman.config.js";

export default createDoorman(config);
