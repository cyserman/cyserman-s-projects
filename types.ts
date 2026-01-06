
export enum PanelTab {
  NOTEPAD = 'NOTEPAD',
  TIMELINE = 'TIMELINE',
  CHAT = 'CHAT',
  LIVE = 'LIVE',
  CONFLICT = 'CONFLICT',
  TERMINAL = 'TERMINAL',
  CLIPBOARD = 'CLIPBOARD'
}

export interface User {
  username: string;
  id: string;
}

export interface NoteRevision {
  id: string;
  content: string;
  rawContent: string;
  timestamp: number;
  author: string;
  hash: string;
}

export interface StickyNote {
  id: string;
  targetId?: string; // Links to a Note.id
  timestamp: number;
  content: string;
  rotation: number; // For visual "pinned" effect
}

export interface Note {
  id: string;
  content: string; 
  rawContent: string;
  timestamp: number;
  lastModified: number;
  type: 'text' | 'voice' | 'file' | 'spine';
  fileName?: string;
  hash?: string;
  isVerified?: boolean;
  revisions: NoteRevision[];
  lane?: 'Plaintiff' | 'Defendant' | 'Neutral' | 'Evidence' | 'Spine';
  confidence: number;
  isSanitized: boolean;
}

export interface ConflictItem {
  id: string;
  statementA: string;
  statementB: string;
  analysis: string;
  severity: 'high' | 'medium' | 'low';
}

export interface DocketStatus {
  percentComplete: number;
  requiredActions: string[];
  currentStage: string;
}

export interface RejectedItem {
  name: string;
  reason: 'Duplicate Content' | 'Stale Version' | 'Empty' | 'Invalid File Type';
  timestamp: number;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  urls?: { uri: string; title: string }[];
}
