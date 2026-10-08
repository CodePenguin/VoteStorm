// Shapes returned by the Netlify functions. Keep in sync with lib/question.js and lib/tally.js.

export type QuestionType = 'choice' | 'rating';
export type StormStatus = 'lobby' | 'active' | 'closed';
export type DisplayType = 'bars' | 'donut';

export interface Question {
  id: number;
  type: QuestionType;
  prompt: string;
  options: string[] | null;
  scaleMin: number | null;
  scaleMax: number | null;
  multi: boolean;
  display: DisplayType;
  resultsHidden: boolean;
  /** Milliseconds until voting closes: null while open, 0 once locked or timed out. */
  votingMsLeft?: number | null;
  /** Indexes of the correct options; null until the presenter reveals them. */
  correct: number[] | null;
}

export interface ChoiceTally {
  counts: number[];
  totalVotes: number;
}

export interface RatingTally {
  counts: Record<number, number>;
  totalVotes: number;
  average: number | null;
}

/** Counts are withheld (hidden: true) while the presenter has hidden a question's results. */
export interface HiddenTally {
  totalVotes: number;
  hidden: true;
}

export type Tally = ChoiceTally | RatingTally | HiddenTally;

export interface StormState {
  status: StormStatus;
  currentQuestion: Question | null;
  tally: Tally | null;
  showConnect: boolean;
}

export type VisibleTally = ChoiceTally | RatingTally;

/** A question plus its final tally, as returned by get-storm-results for closed storms. */
export type ClosedQuestion = Question & { tally: VisibleTally };

/** A question row as the presenter API returns it (database column names, JSON stored as text). */
export interface AdminQuestion {
  id: number;
  storm_code: string;
  order_index: number;
  type: QuestionType;
  prompt: string;
  options: string | null;
  scale_min: number | null;
  scale_max: number | null;
  multi: number;
  results_hidden: number;
  answer_shown: number;
  correct: string | null;
  display: DisplayType | null;
  closes_at?: number | null;
  /** Same meaning as Question.votingMsLeft, as of when the presenter's page last loaded. */
  voting_ms_left?: number | null;
  tally: VisibleTally;
}

export interface AdminStorm {
  storm_code: string;
  status: StormStatus;
  current_question_id: number | null;
  name?: string | null;
  created_at?: number;
  last_activity_at?: number | null;
  inactivity_hours?: number | null;
}

export interface LicenseLimits {
  stormInactivityHours: number;
  maxQuestionsPerStorm?: number;
  maxAudiencePerStorm?: number;
  maxActiveStorms?: number;
}

/** What the server reports about the license a request runs under (never including the license id). */
export interface LicenseSummary {
  tier: 'anonymous' | 'licensed';
  name: string | null;
  expiresAt: number | null;
  limits: LicenseLimits;
}

export interface AdminStormData {
  storm: AdminStorm;
  questions: AdminQuestion[];
  showConnect: boolean;
  resultsBackground: string | null;
  license: LicenseSummary;
}

export interface QuestionForm {
  type: QuestionType;
  prompt: string;
  optionsText: string;
  correctText: string;
  display: DisplayType;
  resultsHidden: boolean;
  multi: boolean;
  scaleMin: number;
  scaleMax: number;
}

export interface QuestionPayload {
  type: QuestionType;
  prompt: string;
  resultsHidden: boolean;
  options?: string[];
  multi?: boolean;
  display?: DisplayType;
  correct?: number[];
  scaleMin?: number;
  scaleMax?: number;
}
