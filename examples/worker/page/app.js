// The page code of the notes example.
//
// The page has 3 parts:
//
// 1. A demo sign-in. The site sets an HttpOnly session cookie.
// 2. The notes of the person, and a form to add a note (the human lane).
// 3. The agent activity log of the person.
//
// After sign-in, the page gives 2 WebMCP tools to the browser. The tools use
// the agent lane. When the person signs out, the page removes the tools and
// forgets the pass.

import { createAgentLaneClient, registerTools } from '/agentlane.js';
import { noteTools } from '/tools.js';

const lane = createAgentLaneClient();
let tools = null; // The AbortController of the registered tools.

const byId = (id) => document.getElementById(id);

// A request on the human lane. It has no lane headers.
async function api(path, init = {}) {
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
  let body = {};
  try {
    body = await response.json();
  } catch (error) {
    body = {};
  }
  if (!response.ok) throw new Error(body.error || `The site responded with HTTP ${response.status}.`);
  return body;
}

function postJson(path, data) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

function showStatus(message) {
  byId('status').textContent = message;
}

async function showSession() {
  const { name } = await api('/api/session');
  byId('signed-out').hidden = Boolean(name);
  byId('signed-in').hidden = !name;
  if (!name) {
    stopTools();
    return;
  }
  byId('person').textContent = name;
  await refresh();
  await startTools();
}

async function startTools() {
  if (tools) return;
  tools = new AbortController();
  const result = registerTools(noteTools({ onChange: () => refresh().catch(() => {}) }), {
    client: lane,
    signal: tools.signal,
  });
  if (result === false) {
    showStatus('This browser has no WebMCP API. The page did not register the tools.');
    return;
  }
  try {
    await result;
    showStatus('The page registered 2 WebMCP tools: list_notes and add_note.');
  } catch (error) {
    tools = null;
    showStatus(`The page could not register the tools: ${error.message}`);
  }
}

function stopTools() {
  if (tools) tools.abort();
  tools = null;
  lane.clear();
}

async function refresh() {
  await Promise.all([showNotes(), showActivity()]);
}

async function showNotes() {
  const { notes } = await api('/api/notes');
  const items = notes.map((note) => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.className = `lane lane-${note.lane}`;
    label.textContent = note.lane === 'agent' ? 'agent' : 'human';
    item.append(label, ` ${note.text}`);
    return item;
  });
  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'There are no notes.';
    items.push(empty);
  }
  byId('notes').replaceChildren(...items);
}

async function showActivity() {
  const { events } = await api('/agentlane/activity?limit=20');
  const rows = events.map((event) => {
    const row = document.createElement('tr');
    const cells = [new Date(event.at).toLocaleTimeString(), event.action, String(event.status), event.code || ''];
    for (const value of cells) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  });
  byId('activity').replaceChildren(...rows);
  byId('no-activity').hidden = rows.length > 0;
}

function onSubmit(id, action) {
  byId(id).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await action(new FormData(form));
      form.reset();
    } catch (error) {
      showStatus(error.message);
    }
  });
}

onSubmit('sign-in', async (data) => {
  await postJson('/api/demo/sign-in', { name: data.get('name') });
  await showSession();
});

onSubmit('add-note', async (data) => {
  await postJson('/api/notes', { text: data.get('text') });
  await refresh();
});

byId('sign-out').addEventListener('click', async () => {
  stopTools();
  await postJson('/api/demo/sign-out', {}).catch((error) => showStatus(error.message));
  showStatus('You signed out. The page removed the tools.');
  await showSession();
});

byId('refresh').addEventListener('click', () => refresh().catch((error) => showStatus(error.message)));

showSession().catch((error) => showStatus(error.message));
