/** Model advice never carries execution authority; only a host decision resolves the queue. */
export interface PendingDirection {id:string;authorId:string;authorName:string;text:string;revision:number}
export interface ConflictContext {fingerprint:string;pending:PendingDirection[];requiresReview:boolean;previousDirection?:Omit<PendingDirection,'revision'>}
export interface ConflictAnalysis {
  summary:string;
  possibleConflicts:{instructionIds:string[];explanation:string}[];
  options:{label:string;text:string}[];
}
export interface ConflictReview {context:ConflictContext;analysis:ConflictAnalysis|null}
export interface DirectionResolution {instructionId:string;resolution:string;resolutionFingerprint:string}
