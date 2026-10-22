// The Worker entry file a deployment ships: build the gate from the project's config.
// A deployment imports from the package: `import {createGate} from "@recodelabs/observatory-gate";`
import {createGate} from "../src/index.js";
import config from "./observatory.config.js";

export default createGate(config);
