// The WebMCP tools of the notes page.
//
// Each tool sends its request through the agent lane with "lane.fetch".
// The lane adds the reference and the proof. A tool result never contains
// the reference or a proof.
//
// This module has no imports. The page loads it from /tools.js, and the
// tests load it in Node.js.

const MAX_NOTE_LENGTH = 280;

/**
 * Return the tools for registerTools().
 * @param {{onChange?: () => void}} [options]  onChange runs after a tool adds a note.
 */
export function noteTools({ onChange = () => {} } = {}) {
  return [
    {
      name: 'list_notes',
      title: 'List notes',
      description:
        'List the notes of the signed-in person, newest first. ' +
        'Each note has its text, the lane that added it ("agent" or "human") and the time in epoch milliseconds.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      // People write the notes. Thus the result can contain text that is not safe to follow.
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(_input, { lane, signal }) {
        const body = await send(lane, '/api/notes', { signal });
        return { notes: body.notes };
      },
    },
    {
      name: 'add_note',
      title: 'Add a note',
      description: `Add 1 note for the signed-in person. The text has 1 to ${MAX_NOTE_LENGTH} characters.`,
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_NOTE_LENGTH,
            description: 'The text of the note.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      // The tool changes data of the person.
      annotations: { consequentialHint: true },
      async execute(input, { lane, signal }) {
        const text = input && typeof input.text === 'string' ? input.text : '';
        const body = await send(lane, '/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal,
        });
        onChange();
        return { note: body.note };
      },
    },
  ];
}

// Send 1 request through the agent lane. If the site rejects it, stop with
// the error text of the site, for example the budget and the wait time.
async function send(lane, path, init) {
  if (!lane) throw new Error('The agent lane is not available on this page.');
  const response = await lane.fetch(path, init);
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  if (!response.ok) {
    const reason = body && typeof body.error === 'string' ? body.error : `The site responded with HTTP ${response.status}.`;
    throw new Error(reason);
  }
  return body;
}
