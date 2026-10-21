import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const { esbuild: presets } = createPluginBundlerPresets();
await Promise.all([
  esbuild.build({ ...presets.worker, external: ["@paperclipai/plugin-sdk"] }),
  esbuild.build(presets.manifest),
]);
