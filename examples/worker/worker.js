// The Worker of the notes example.
//
// Wrangler bundles this file. The "rules" in wrangler.jsonc import the page
// files and the lane client as text, so that the Worker can serve them:
//
//   /            page/index.html
//   /app.js      page/app.js
//   /tools.js    page/tools.js
//   /agentlane.js  src/browser/agentlane.js
//
// withAgentLane() adds the agent lane to the site:
//
//   POST /agentlane/pass      gives a pass to the signed-in page
//   GET  /agentlane/activity  shows the activity log of the person
//   requests with lane headers  checked before they get to the site

import { withAgentLane, AgentLaneStore } from '../../src/cloudflare/index.js';
import laneScript from '../../src/browser/agentlane.js'; // Text (see wrangler.jsonc).
import appScript from './page/app.js'; // Text.
import toolsScript from './page/tools.js'; // Text.
import pageHtml from './page/index.html'; // Text.
import { createNotesSite, laneOptions } from './site.js';

const site = createNotesSite({ pageHtml, appScript, toolsScript, laneScript });

export default withAgentLane(site, laneOptions(site));

// The Durable Object class of the agent lane store. The binding is AGENTLANE.
export { AgentLaneStore };
