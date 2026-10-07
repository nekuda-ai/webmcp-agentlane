// Tests for registerTools (src/browser/agentlane.js).
// The tests run in Node.js with fake WebMCP APIs:
//
// - DraftModelContext acts like document.modelContext in the W3C WebMCP
//   draft: registerTool(tool, { signal, exposedTo }) returns a promise, and
//   an abort of the signal removes the tool.
// - OldModelContext acts like navigator.modelContext in older Chrome
//   versions: registerTool(tool) ignores the options, and unregisterTool(name)
//   removes a tool.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools, createAgentLaneClient } from '../src/browser/agentlane.js';

class DraftModelContext {
  tools = new Map();
  options = [];
  async registerTool(tool, options = {}) {
    const { signal, exposedTo } = options;
    this.options.push({ signal, exposedTo });
    if (signal && signal.aborted) throw signal.reason;
    if (this.tools.has(tool.name)) throw new DOMException(`Duplicate tool: ${tool.name}`, 'InvalidStateError');
    this.tools.set(tool.name, tool);
    if (signal) signal.addEventListener('abort', () => this.tools.delete(tool.name), { once: true });
  }
}

class OldModelContext {
  tools = new Map();
  removed = [];
  registerTool(tool) {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }
  unregisterTool(name) {
    this.removed.push(name);
    if (!this.tools.delete(name)) throw new Error(`Unknown tool: ${name}`);
  }
}

// Replace globals for 1 test, and put the old values back after it.
function setGlobals(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => {
      if (before) Object.defineProperty(globalThis, name, before);
      else delete globalThis[name];
    });
  }
}

function sampleTools(calls = []) {
  return [
    {
      name: 'list_notes',
      title: 'List notes',
      description: 'List the notes of the person.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, context) {
        calls.push({ tool: 'list_notes', input, context, self: this });
        return { notes: [] };
      },
    },
    {
      name: 'add_note',
      description: 'Add 1 note.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      annotations: { consequentialHint: true },
      async execute(input, context) {
        calls.push({ tool: 'add_note', input, context });
        return { added: input.text };
      },
    },
  ];
}

const fakeClient = () => createAgentLaneClient({ fetchImpl: async () => new Response('{}') });

describe('registerTools: WebMCP API', () => {
  test('returns false when the browser has no WebMCP API', (t) => {
    setGlobals(t, { document: {}, navigator: {} });
    assert.equal(registerTools(sampleTools(), { client: fakeClient() }), false);
  });

  test('returns false when there is no document and no navigator', (t) => {
    setGlobals(t, { document: undefined, navigator: undefined });
    assert.equal(registerTools(sampleTools()), false);
  });

  test('uses document.modelContext before navigator.modelContext', async (t) => {
    const draft = new DraftModelContext();
    const old = new OldModelContext();
    setGlobals(t, { document: { modelContext: draft }, navigator: { modelContext: old } });
    assert.equal(await registerTools(sampleTools()), true);
    assert.deepEqual([...draft.tools.keys()], ['list_notes', 'add_note']);
    assert.equal(old.tools.size, 0);
  });

  test('uses navigator.modelContext when document.modelContext does not exist', async (t) => {
    const old = new OldModelContext();
    setGlobals(t, { document: {}, navigator: { modelContext: old } });
    assert.equal(await registerTools(sampleTools()), true);
    assert.deepEqual([...old.tools.keys()], ['list_notes', 'add_note']);
  });

  test('gives the WebMCP fields of each tool, and nothing more', async (t) => {
    const draft = new DraftModelContext();
    setGlobals(t, { document: { modelContext: draft } });
    const tools = sampleTools();
    tools[0].secretField = 'do not copy';
    await registerTools(tools);

    const listNotes = draft.tools.get('list_notes');
    assert.deepEqual(Object.keys(listNotes).sort(), ['annotations', 'description', 'execute', 'inputSchema', 'name', 'title']);
    assert.equal(listNotes.title, 'List notes');
    assert.equal(listNotes.description, 'List the notes of the person.');
    assert.deepEqual(listNotes.inputSchema, { type: 'object', properties: {} });
    assert.deepEqual(listNotes.annotations, { readOnlyHint: true, untrustedContentHint: true });

    const addNote = draft.tools.get('add_note');
    assert.equal('title' in addNote, false);
    assert.deepEqual(addNote.annotations, { consequentialHint: true });
  });

  test('execute gets the input, the lane client and the signal of the tool call', async (t) => {
    const draft = new DraftModelContext();
    setGlobals(t, { document: { modelContext: draft } });
    const calls = [];
    const tools = sampleTools(calls);
    const client = fakeClient();
    await registerTools(tools, { client });

    const call = new AbortController();
    const result = await draft.tools.get('add_note').execute({ text: 'hello' }, { signal: call.signal });
    assert.deepEqual(result, { added: 'hello' });
    assert.deepEqual(calls[0].input, { text: 'hello' });
    assert.equal(calls[0].context.lane, client);
    assert.equal(calls[0].context.signal, call.signal);

    // Older APIs give no options. Then the signal is undefined.
    await draft.tools.get('list_notes').execute({});
    assert.equal(calls[1].context.lane, client);
    assert.equal(calls[1].context.signal, undefined);
    assert.equal(calls[1].self, tools[0], 'execute runs as a method of the tool');
  });

  test('passes exposedTo to the WebMCP API', async (t) => {
    const draft = new DraftModelContext();
    setGlobals(t, { document: { modelContext: draft } });
    await registerTools(sampleTools(), { exposedTo: ['https://notes.example'] });
    assert.deepEqual(draft.options[0].exposedTo, ['https://notes.example']);
  });

  test('errors from execute go to the WebMCP API', async (t) => {
    const draft = new DraftModelContext();
    setGlobals(t, { document: { modelContext: draft } });
    const tools = sampleTools();
    tools[1].execute = async () => {
      throw new Error('The budget "notes-write" has no room now.');
    };
    await registerTools(tools);
    await assert.rejects(draft.tools.get('add_note').execute({ text: 'x' }, {}), /notes-write/);
  });
});

describe('registerTools: abort signal', () => {
  test('an abort of the signal removes all tools (draft API)', async (t) => {
    const draft = new DraftModelContext();
    setGlobals(t, { document: { modelContext: draft } });
    const controller = new AbortController();
    await registerTools(sampleTools(), { signal: controller.signal });
    assert.equal(draft.tools.size, 2);
    assert.ok(draft.options.every((options) => options.signal && options.signal.aborted === false));

    controller.abort();
    assert.equal(draft.tools.size, 0);
  });

  test('an abort of the signal removes all tools (older API with unregisterTool)', async (t) => {
    const old = new OldModelContext();
    setGlobals(t, { document: {}, navigator: { modelContext: old } });
    const controller = new AbortController();
    await registerTools(sampleTools(), { signal: controller.signal });
    assert.equal(old.tools.size, 2);

    controller.abort();
    assert.equal(old.tools.size, 0);
    assert.deepEqual(old.removed, ['list_notes', 'add_note']);
  });

  test('the draft API does not get unregisterTool calls', async (t) => {
    const draft = new DraftModelContext();
    let unregisterCalls = 0;
    draft.unregisterTool = () => unregisterCalls++;
    setGlobals(t, { document: { modelContext: draft } });
    const controller = new AbortController();
    await registerTools(sampleTools(), { signal: controller.signal });
    controller.abort();
    assert.equal(unregisterCalls, 0);
    assert.equal(draft.tools.size, 0);
  });

  test('a signal that is already aborted registers nothing', async (t) => {
    const draft = new DraftModelContext();
    setGlobals(t, { document: { modelContext: draft } });
    const controller = new AbortController();
    controller.abort(new Error('signed out'));
    await assert.rejects(registerTools(sampleTools(), { signal: controller.signal }), { message: 'signed out' });
    assert.equal(draft.options.length, 0);
    assert.equal(draft.tools.size, 0);
  });

  test('if 1 tool fails, the tools of the same call are removed', async (t) => {
    const draft = new DraftModelContext();
    setGlobals(t, { document: { modelContext: draft } });
    // "add_note" exists from an earlier call.
    await registerTools([sampleTools()[1]]);
    await assert.rejects(registerTools(sampleTools()), { name: 'InvalidStateError' });
    assert.deepEqual([...draft.tools.keys()], ['add_note']);
  });

  test('if 1 tool fails with the older API, the tools of the same call are removed', async (t) => {
    const old = new OldModelContext();
    setGlobals(t, { document: {}, navigator: { modelContext: old } });
    await registerTools([sampleTools()[1]]);
    await assert.rejects(registerTools(sampleTools()), /Duplicate tool: add_note/);
    assert.deepEqual([...old.tools.keys()], ['add_note']);
    assert.deepEqual(old.removed, ['list_notes']);
  });

  test('an abort during registration stops it and removes the tools', async (t) => {
    const draft = new DraftModelContext();
    const controller = new AbortController();
    const register = draft.registerTool.bind(draft);
    draft.registerTool = async (tool, options) => {
      await register(tool, options);
      if (tool.name === 'list_notes') controller.abort(new Error('stop'));
    };
    setGlobals(t, { document: { modelContext: draft } });
    await assert.rejects(registerTools(sampleTools(), { signal: controller.signal }), { message: 'stop' });
    assert.equal(draft.tools.size, 0);
  });
});

describe('registerTools: checks', () => {
  test('checks the tools even when the browser has no WebMCP API', (t) => {
    setGlobals(t, { document: {}, navigator: {} });
    const base = sampleTools()[0];
    const bad = [
      [{ ...base, name: 'list notes' }, /the name must have/],
      [{ ...base, name: 'x'.repeat(129) }, /the name must have/],
      [{ ...base, description: ' ' }, /must have a description/],
      [{ ...base, execute: 'run' }, /must have an execute function/],
      [{ ...base, title: 5 }, /the title/],
      [{ ...base, inputSchema: [] }, /"inputSchema"/],
      [{ ...base, annotations: null }, /"annotations"/],
      [null, /it must be an object/],
    ];
    for (const [tool, message] of bad) {
      assert.throws(() => registerTools([tool]), { name: 'TypeError', message });
    }
    assert.throws(() => registerTools([base, { ...base }]), /2 tools have the name "[^"]+"\. Give each tool a different name\./);
    assert.throws(() => registerTools('list_notes'), TypeError);
  });

  test('checks the options', (t) => {
    setGlobals(t, { document: { modelContext: new DraftModelContext() } });
    assert.throws(() => registerTools([], { client: {} }), /createAgentLaneClient/);
    assert.throws(() => registerTools([], { signal: {} }), /AbortSignal/);
    assert.throws(() => registerTools([], { exposedTo: 'https://notes.example' }), /list of origins/);
    assert.throws(() => registerTools([], null), TypeError);
  });

  test('accepts tool names with letters, digits, "_", "-" and "."', async (t) => {
    const draft = new DraftModelContext();
    setGlobals(t, { document: { modelContext: draft } });
    const base = sampleTools()[0];
    await registerTools([{ ...base, name: 'notes.list-all_v2' }]);
    assert.ok(draft.tools.has('notes.list-all_v2'));
  });
});
