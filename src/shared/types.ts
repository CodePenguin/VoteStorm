// Shapes returned by the Netlify functions. Keep in sync with lib/cloud.js and lib/tally.js.

export type CloudKind = 'choice' | 'rating' | 'words' | 'content';
export type StormStatus = 'lobby' | 'active' | 'closed';
export type DisplayType = 'bars' | 'donut';

export interface Cloud {
  id: number;
  kind: CloudKind;
  body: string;
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
  /** Words one person may send; null for other kinds. */
  maxWords: number | null;
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

/** Counts are withheld (hidden: true) while the presenter has hidden a cloud's results. */
export interface HiddenTally {
  totalVotes: number;
  hidden: true;
}

export type Tally = ChoiceTally | RatingTally | WordsTally | HiddenTally;

export interface StormState {
  status: StormStatus;
  currentCloud: Cloud | null;
  tally: Tally | null;
  showConnect: boolean;
}

/** Words are sorted by count, most used first, with removed words left out. */
export interface WordsTally {
  words: { word: string; count: number }[];
  totalVotes: number;
}

export type VisibleTally = ChoiceTally | RatingTally | WordsTally;

/** A cloud plus its final tally, as returned by get-storm-results for closed storms. */
export type ClosedCloud = Cloud & { tally: VisibleTally };

/** A cloud row as the presenter API returns it (database column names, JSON stored as text). */
export interface AdminCloud {
  id: number;
  storm_code: string;
  order_index: number;
  kind: CloudKind;
  body: string;
  options: string | null;
  scale_min: number | null;
  scale_max: number | null;
  multi: number;
  results_hidden: number;
  answer_shown: number;
  correct: string | null;
  display: DisplayType | null;
  max_words: number | null;
  hidden_words: string | null;
  closes_at?: number | null;
  /** Same meaning as Cloud.votingMsLeft, as of when the presenter's page last loaded. */
  voting_ms_left?: number | null;
  tally: VisibleTally;
}

export interface AdminStorm {
  storm_code: string;
  status: StormStatus;
  current_cloud_id: number | null;
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
  clouds: AdminCloud[];
  showConnect: boolean;
  resultsBackground: string | null;
  license: LicenseSummary;
}

export interface CloudForm {
  kind: CloudKind;
  body: string;
  optionsText: string;
  correctText: string;
  display: DisplayType;
  resultsHidden: boolean;
  multi: boolean;
  scaleMin: number;
  scaleMax: number;
  maxWords: number;
}

export interface CloudPayload {
  kind: CloudKind;
  body: string;
  resultsHidden?: boolean;
  maxWords?: number;
  options?: string[];
  multi?: boolean;
  display?: DisplayType;
  correct?: number[];
  scaleMin?: number;
  scaleMax?: number;
}
