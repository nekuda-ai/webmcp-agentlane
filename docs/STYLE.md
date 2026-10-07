# Writing rules

All text in this repository uses plain, controlled English. The rules come from
ASD-STE100 (Simplified Technical English), the writing standard for aircraft
maintenance documents. We do not apply the full standard. We use its main ideas,
because a reader must understand each sentence the first time.

## Sentences

1. Write one idea in one sentence.
2. Keep instructions to 20 words or fewer. Keep descriptions to 25 words or fewer.
3. Use the active voice. Write "The server rejects the request." Do not write "The
   request is rejected by the server."
4. Use the present tense for descriptions. Use the imperative for instructions:
   "Set the secret." Not "You should set the secret."
5. Put a condition before the action: "If the pass expires, get a new pass."
6. Keep "the", "a" and "an". Do not drop them to make text shorter.

## Paragraphs

1. Write one topic in one paragraph.
2. Use 6 sentences or fewer in a paragraph.
3. Put the most important sentence first.
4. Use a list for 3 or more items. Use a table to compare things.

## Words

1. Use one word for one meaning. Use the terms in the glossary below, and always
   the same term for the same thing.
2. Use common words. Write "use", not "leverage". Write "start", not "initiate".
3. Do not use idioms, slang, jokes or marketing words ("seamless", "robust",
   "powerful", "game-changing", "simply", "just").
4. Avoid "-ing" words as nouns or adjectives when another form is clear.
   Write "to verify the proof", not "proof verifying".
5. Write numbers and units in full: "15 minutes", "1 booking", "HTTP 429".
6. Define a technical term at its first use, or link to the glossary.

## Glossary

| Term | Meaning |
|---|---|
| **WebMCP Dedicated Agent Lane** | The name of this project. In running text, write "the agent lane". The package name is `@nekuda/webmcp-agentlane`. |
| **site** | A website that offers WebMCP tools. |
| **site owner** | The team that runs the site. |
| **person** | The human who is signed in to the site. |
| **agent** | Software that acts for the person, for example an AI assistant in a browser. |
| **WebMCP tool** | A named action that the site's page gives to agents, with an input schema. |
| **agent lane** | The path that tool requests use to reach the site. It has its own rules, budgets and log. |
| **human lane** | The path that the site's normal page and buttons use. |
| **pass** | A short-lived permission that the site gives to the page for tool requests. |
| **reference** | The random identifier of a pass. |
| **proof** | A signature that shows the site issued the pass for one action. |
| **lane headers** | The 2 headers that carry the reference and the proof of a tool request. |
| **lane client** | The code in the page that gets passes and adds the lane headers to tool requests (`src/browser/agentlane.js`). |
| **action** | One HTTP method and path, for example `POST /api/reservations`. |
| **scope** | The list of actions that a pass permits. |
| **budget** | A limit on how many tool requests the agent lane accepts in a time window. |
| **activity log** | The record of tool requests and their results. |
| **edge** | The network layer in front of the site, for example Cloudflare. |
