export interface ActivityLabels {
  working: string;
  done: string;
}

// Requests that happen on their own (not because the user did something) never show a notice.
const SILENT_PATHS = ['results-activate', 'ably-token', 'resolve-results-key'];

function parseBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'string') return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const has = (body: Record<string, unknown>, key: string) => body[key] !== undefined;
// A word cloud's vote is a list of words; a multi-select vote is a list of numbers.
const isWordList = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string');

/** Plain-language messages for a server request, or null when the user needs no notice (reads and background calls). */
export function describeActivity(path: string, method: string, rawBody?: unknown): ActivityLabels | null {
  const name = path.split('?')[0];
  const verb = method.toUpperCase();
  if (SILENT_PATHS.includes(name) || verb === 'GET') return null;
  const body = parseBody(rawBody);

  switch (name) {
    case 'vote':
      if (isWordList(body.value)) return { working: 'Sending your words\u2026', done: 'Words sent' };
      return { working: 'Submitting your vote\u2026', done: 'Vote submitted' };
    case 'duplicate-storm':
      return { working: 'Duplicating Storm\u2026', done: 'Storm duplicated' };
    case 'create-storm':
      return { working: 'Creating your Storm\u2026', done: 'Storm created' };
    case 'admin-clouds':
      if (verb === 'DELETE') return { working: 'Deleting cloud\u2026', done: 'Cloud deleted' };
      if (verb === 'POST') return { working: 'Adding cloud\u2026', done: 'Cloud added' };
      if (has(body, 'edit')) return { working: 'Saving cloud\u2026', done: 'Cloud saved' };
      if (body.action === 'reset') return { working: 'Resetting votes\u2026', done: 'Votes reset' };
      if (has(body, 'hideWord')) return { working: 'Removing word…', done: 'Word removed' };
      if (has(body, 'showWord')) return { working: 'Restoring word…', done: 'Word restored' };
      if (has(body, 'orderIndex')) return { working: 'Saving order\u2026', done: 'Order saved' };
      return { working: 'Saving\u2026', done: 'Saved' };
    case 'admin-storm':
      if (verb === 'DELETE') return { working: 'Deleting Storm\u2026', done: 'Storm deleted' };
      if (body.action === 'reset') return { working: 'Resetting votes\u2026', done: 'Votes reset' };
      if (has(body, 'showConnect')) return { working: 'Updating join screen\u2026', done: 'Join screen updated' };
      if (has(body, 'resultsBackground')) return { working: 'Updating background\u2026', done: 'Background updated' };
      if (body.clearTimer === true) return { working: 'Clearing timer\u2026', done: 'Timer cleared' };
      if (has(body, 'votingLocked') && body.words === true) {
        return body.votingLocked ? { working: 'Locking submissions…', done: 'Submissions locked' } : { working: 'Unlocking submissions…', done: 'Submissions open' };
      }
      if (has(body, 'votingLocked')) return body.votingLocked ? { working: 'Locking voting\u2026', done: 'Voting locked' } : { working: 'Unlocking voting\u2026', done: 'Voting open' };
      if (has(body, 'votingSeconds')) return { working: 'Starting timer\u2026', done: 'Timer started' };
      if (has(body, 'votingAddSeconds')) return { working: 'Adding time\u2026', done: 'Time added' };
      if (has(body, 'resultsHidden') || has(body, 'answerShown')) return { working: 'Updating results\u2026', done: 'Results updated' };
      if (has(body, 'currentCloudId')) return { working: 'Changing cloud\u2026', done: 'Cloud changed' };
      if (body.status === 'closed') return { working: 'Ending Storm\u2026', done: 'Storm ended' };
      if (has(body, 'status')) return { working: 'Updating Storm\u2026', done: 'Storm updated' };
      return { working: 'Saving\u2026', done: 'Saved' };
    default:
      return { working: 'Saving\u2026', done: 'Saved' };
  }
}
