/** Author-curated sidecar data; no implicit manuscript edits or inferred facts. */
export interface SceneEvidence {
	documentId: string;
	quote?: string;
	note: string;
	status: 'explicit' | 'inferred' | 'uncertain' | 'author-confirmed';
}

export interface FieldOfCrowsSceneRecord {
	schemaVersion: 1;
	projectId: string;
	documentId: string;
	chapterId?: string;
	binderOrder: number;
	characters: Array<{ name: string; presence: 'present' | 'mentioned'; evidence: SceneEvidence }>;
	timeline?: { id: string; storyDate?: string; sequence?: number; evidence: SceneEvidence };
	clues: Array<{ id: string; role: 'plant' | 'reinforcement' | 'reveal'; evidence: SceneEvidence }>;
	continuity: Array<{ topic: string; observation: string; evidence: SceneEvidence }>;
	emotion?: { label: string; intensity?: number; scale?: string; evidence: SceneEvidence };
}
