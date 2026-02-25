export type AnnotationEdit = {
  bbox: [number, number, number, number];
  provenance: {
    source: string;
    updatedAt: string;
    sourceAnnotationId?: number;
  };
};

export type RuntimeDependencyStatus = {
  name: string;
  resolvedPath: string;
};

export type RuntimeDependencyReport = {
  ffmpeg: RuntimeDependencyStatus;
  ffprobe: RuntimeDependencyStatus;
};

export type ImportStageOptions = {
  datasetRoot: string;
  cocoJsonPath: string;
  mp4Path: string;
};


export type GenerateReviewDatasetOptions = {
  datasetRoot: string;
  cocoJsonPath: string;
  mp4Path: string;
  generatedAt: string;
  faces: string[];
  renderSize: number;
  horizontalFovDegrees: number;
  minProjectedBoxArea: number;
  qualityProfile?: "high" | "balanced" | "low";
  gpuAcceleration?: "off" | "auto" | "vaapi" | "qsv" | "videotoolbox" | "d3d11va" | "dxva2";
};

export type GenerateReviewDatasetReport = {
  writtenManifestPath: string;
  faceCount: number;
  filteredBoxCount: number;
  extractedFrameCount: number;
  skippedExistingCount: number;
};

export type StartGenerationResponse = {
  jobId: string;
};

export type GenerationJobState = "pending" | "running" | "aborting" | "cancelled" | "done" | "error";

export type GenerationStatusResponse = {
  jobId: string;
  state: GenerationJobState;
  message: string;
  result?: GenerateReviewDatasetReport;
};

export type AbortGenerationResponse = {
  jobId: string;
  state: GenerationJobState;
  message: string;
};

export type GenerationProgressEvent = {
  phase: string;
  detail: string;
  completed: number;
  total: number;
  percent: number;
  elapsedMs: number;
};

export type ExtractFramesFromMp4Options = {
  datasetRoot: string;
  cocoJsonPath: string;
  mp4Path: string;
};

export type ExtractFramesFromMp4Report = {
  mp4FrameCount: number;
  extractedFrameCount: number;
  skippedExistingCount: number;
};

export type ImportStageReport = {
  datasetRoot: string;
  cocoJsonPath: string;
  mp4Path: string;
  imageCount: number;
  annotationCount: number;
  categoryCount: number;
  referencedImageCount: number;
};

export type OpenDatasetReport = {
  datasetRoot: string;
  manifestPath: string;
  faceCount: number;
};

export type FaceListItem = {
  faceId: string;
  face: string;
  imagePath: string;
  initialBoxCount: number;
};

export type ListFacesReport = {
  datasetRoot: string;
  faces: FaceListItem[];
};

export type ExportCocoOptions = {
  datasetRoot: string;
  outputPath: string;
};

export type ExportCocoReport = {
  outputPath: string;
  imageCount: number;
  annotationCount: number;
};

export type StageDroppedInputsRequest = {
  paths: string[];
};

export type StageDroppedInputsReport = {
  workspaceRoot: string;
  stagedDatasetRoot?: string;
  stagedCocoJsonPath?: string;
  stagedMp4Path?: string;
  ignoredPaths: string[];
};

export type LlmProviderId = "openai" | "anthropic";
export type ReasoningPreset = "high" | "balanced" | "low";

export type ProviderSettings = {
  enabled: boolean;
  model: string;
  hasKey: boolean;
};

export type LlmSettingsResponse = {
  llmSuggestionsEnabled: boolean;
  reasoningPreset: ReasoningPreset;
  prefetchBufferSize: number;
  openai: ProviderSettings;
  anthropic: ProviderSettings;
};

export type SaveLlmSettingsRequest = {
  llmSuggestionsEnabled: boolean;
  reasoningPreset: ReasoningPreset;
  prefetchBufferSize: number;
  openai: { enabled: boolean; model: string };
  anthropic: { enabled: boolean; model: string };
};

export type SetLlmApiKeyRequest = {
  provider: LlmProviderId;
  apiKey: string;
};

export type SuggestionBox = {
  bbox: [number, number, number, number];
  confidence?: number;
  source: string;
};

export type SuggestionResponse = {
  faceId: string;
  provider: string;
  model: string;
  suggestions: SuggestionBox[];
  attempts: number;
};

export type QueueStateItem = {
  faceId: string;
  status: string;
};

export type QueueStateResponse = {
  items: QueueStateItem[];
};
