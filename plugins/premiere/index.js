"use strict";
const { entrypoints } = require("uxp");
const { createHost } = require("./host.js");
const { createBridge } = require("./bridge.js");
const { startPanel } = require("./panel.js");
entrypoints.setup({ panels: { editstyle: { show() {} } } });
startPanel(document, createHost(require("premierepro")), createBridge(fetch));
