// Applies to `remotion render` and the Studio's render button. The
// composition is authored at 1280x640 / 30 fps; the README GIF keeps every
// second frame and is scaled to 960x480, which GitHub shows near 1:1.
import { Config } from "@remotion/cli/config";

Config.setCodec("gif");
Config.setEveryNthFrame(2);
Config.setScale(0.75);
// PNG frames keep text edges clean for the GIF palette; JPEG adds noise.
Config.setVideoImageFormat("png");
Config.setOverwriteOutput(true);
// Off the common dev-server ports: a server listening on [::]:3000 can answer
// the renderer's localhost requests in place of its own bundle.
Config.setRendererPort(3917);
