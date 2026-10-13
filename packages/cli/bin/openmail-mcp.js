#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// A committed shim, so pnpm can link the bin before `pnpm build` creates dist/.
import "../dist/mcp.js";
