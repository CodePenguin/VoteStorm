import type { AdminQuestion, Question, QuestionForm, QuestionPayload, RoomStatus } from '@/shared/types';

export function blankForm(): QuestionForm {
  return { type: 'choice', prompt: '', optionsText: '', correctText: '', display: 'bars', resultsHidden: false, multi: false, scaleMin: 1, scaleMax: 5 };
}

export function parseOptions(q: AdminQuestion): string[] {
  return q.options ? (JSON.parse(q.options) as string[]) : [];
}

export function parseCorrect(q: AdminQuestion): number[] {
  return q.correct ? (JSON.parse(q.correct) as number[]) : [];
}

export function formFromQuestion(q: AdminQuestion): QuestionForm {
  const options = parseOptions(q);
  return {
    type: q.type,
    prompt: q.prompt,
    optionsText: options.join(', '),
    correctText: parseCorrect(q).map((i) => options[i]).filter(Boolean).join(', '),
    display: q.display === 'donut' ? 'donut' : 'bars',
    resultsHidden: !!q.results_hidden,
    multi: !!q.multi,
    scaleMin: q.scale_min ?? 1,
    scaleMax: q.scale_max ?? 5,
  };
}

/** Turns the form into an API payload; correct answers are typed as option text and mapped to indexes. */
export function buildQuestionPayload(f: QuestionForm): QuestionPayload {
  const payload: QuestionPayload = { type: f.type, prompt: f.prompt, resultsHidden: !!f.resultsHidden };
  if (f.type === 'choice') {
    const options = f.optionsText.split(',').map((x) => x.trim()).filter(Boolean);
    payload.options = options;
    payload.multi = !!f.multi;
    payload.display = f.display;
    const wanted = f.correctText.split(',').map((x) => x.trim()).filter(Boolean);
    const lower = options.map((o) => o.toLowerCase());
    const missing = wanted.filter((w) => !lower.includes(w.toLowerCase()));
    if (missing.length) throw new Error(`Correct answer "${missing[0]}" is not one of the options`);
    if (wanted.length) payload.correct = wanted.map((w) => lower.indexOf(w.toLowerCase()));
  } else {
    payload.scaleMin = f.scaleMin;
    payload.scaleMax = f.scaleMax;
  }
  return payload;
}

/** The presenter always sees the counts and correct answer, even while they are hidden from the audience. */
export function toPrivateQuestion(q: AdminQuestion): Question {
  return {
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    options: q.options ? (JSON.parse(q.options) as string[]) : null,
    scaleMin: q.scale_min,
    scaleMax: q.scale_max,
    multi: !!q.multi,
    display: q.display === 'donut' ? 'donut' : 'bars',
    resultsHidden: false,
    correct: q.correct ? (JSON.parse(q.correct) as number[]) : null,
  };
}

export function statusLabel(status: RoomStatus): string {
  return { lobby: 'Lobby', active: 'Live', closed: 'Closed' }[status] ?? status;
}
