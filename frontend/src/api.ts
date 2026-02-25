import { invoke } from "@tauri-apps/api/core";
import type {
  AnnotationEdit,
  ExtractFramesFromMp4Options,
  ExtractFramesFromMp4Report,
  ExportCocoOptions,
  ExportCocoReport,
  GenerateReviewDatasetOptions,
  GenerateReviewDatasetReport,
  GenerationStatusResponse,
  ImportStageOptions,
  ImportStageReport,
  ListFacesReport,
  OpenDatasetReport,
  RuntimeDependencyReport,
  StageDroppedInputsReport,
  LlmSettingsResponse,
  SaveLlmSettingsRequest,
  SuggestionResponse,
  QueueStateResponse,
  LlmProviderId,
  StartGenerationResponse,
  AbortGenerationResponse,
  SetLlmApiKeyRequest,
} from "./types";

const normalizeInboundEdit = (edit: AnnotationEdit | Record<string, unknown>): AnnotationEdit => {
  const provenanceRaw = (edit as { provenance?: Record<string, unknown> }).provenance ?? {};
  return {
    bbox: ((edit as { bbox: [number, number, number, number] }).bbox),
    provenance: {
      source: String(provenanceRaw.source ?? ""),
      updatedAt: String(provenanceRaw.updatedAt ?? provenanceRaw.updated_at ?? ""),
      ...(typeof provenanceRaw.sourceAnnotationId === "number"
        ? { sourceAnnotationId: provenanceRaw.sourceAnnotationId }
        : (typeof provenanceRaw.source_annotation_id === "number"
          ? { sourceAnnotationId: provenanceRaw.source_annotation_id }
          : {})),
    },
  };
};

const normalizeOutboundEdit = (edit: AnnotationEdit): AnnotationEdit => ({
  bbox: edit.bbox,
  provenance: {
    source: edit.provenance.source,
    updatedAt: edit.provenance.updatedAt,
    ...(typeof edit.provenance.sourceAnnotationId === "number"
      ? { sourceAnnotationId: edit.provenance.sourceAnnotationId }
      : {}),
  },
});

export const runImportStage = async (options: ImportStageOptions) =>
  invoke<ImportStageReport>("run_import_stage_command", { options });

export const openDataset = async (datasetRoot: string) =>
  invoke<OpenDatasetReport>("open_dataset_command", {
    request: { datasetRoot },
  });

export const listFaces = async (datasetRoot: string) =>
  invoke<ListFacesReport>("list_faces_command", {
    request: { datasetRoot },
  });

export const getAnnotations = async (datasetRoot: string, faceId: string) =>
  invoke<AnnotationEdit[]>("get_annotations_command", {
    request: { datasetRoot, faceId },
  }).then((edits) => edits.map((edit) => normalizeInboundEdit(edit)));

export const setAnnotations = async (
  datasetRoot: string,
  faceId: string,
  edits: AnnotationEdit[]
) =>
  invoke<AnnotationEdit[]>("set_annotations_command", {
    request: { datasetRoot, faceId, edits: edits.map((edit) => normalizeOutboundEdit(edit)) },
  }).then((saved) => saved.map((edit) => normalizeInboundEdit(edit)));

export const exportCoco = async (options: ExportCocoOptions) =>
  invoke<ExportCocoReport>("export_coco_command", { request: options });

export const generateReviewDataset = async (options: GenerateReviewDatasetOptions) =>
  invoke<GenerateReviewDatasetReport>("generate_review_dataset_command", {
    request: options,
  });

export const startGenerateReviewDataset = async (options: GenerateReviewDatasetOptions) =>
  invoke<StartGenerationResponse>("start_generate_review_dataset_command", {
    request: options,
  });

export const getGenerationStatus = async (jobId: string) =>
  invoke<GenerationStatusResponse>("get_generation_status_command", {
    request: { jobId },
  });

export const abortGenerationJob = async (jobId: string) =>
  invoke<AbortGenerationResponse>("abort_generation_job_command", {
    request: { jobId },
  });

export const extractFramesFromMp4 = async (options: ExtractFramesFromMp4Options) =>
  invoke<ExtractFramesFromMp4Report>("extract_frames_from_mp4_command", {
    request: options,
  });

export const checkRuntimeDependencies = async () =>
  invoke<RuntimeDependencyReport>("check_runtime_dependencies_command");


export const stageDroppedInputs = async (paths: string[]) =>
  invoke<StageDroppedInputsReport>("stage_dropped_inputs_command", {
    request: { paths },
  });


export const getLlmSettings = async () => invoke<LlmSettingsResponse>("get_llm_settings_command");

export const saveLlmSettings = async (request: SaveLlmSettingsRequest) =>
  invoke<LlmSettingsResponse>("save_llm_settings_command", { request });

export const setLlmApiKey = async (request: SetLlmApiKeyRequest) =>
  invoke<void>("set_llm_api_key_command", { request });

export const clearLlmApiKey = async (provider: LlmProviderId) =>
  invoke<void>("clear_llm_api_key_command", { request: { provider } });

export const getSuggestions = async (datasetRoot: string, faceId: string, timeoutMs?: number) =>
  invoke<SuggestionResponse>("get_suggestions_command", {
    request: { datasetRoot, faceId, timeoutMs },
  });

export const prefetchSuggestions = async (datasetRoot: string, faceIds: string[]) =>
  invoke<QueueStateResponse>("prefetch_suggestions_command", {
    request: { datasetRoot, faceIds },
  });

export const getSuggestionQueueState = async (datasetRoot: string, faceIds: string[]) =>
  invoke<QueueStateResponse>("get_suggestion_queue_state_command", { datasetRoot, faceIds });
