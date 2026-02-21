import { invoke } from "@tauri-apps/api/core";
import type {
  AnnotationEdit,
  ExtractFramesFromMp4Options,
  ExtractFramesFromMp4Report,
  ExportCocoOptions,
  ExportCocoReport,
  GenerateReviewDatasetOptions,
  GenerateReviewDatasetReport,
  ImportStageOptions,
  ImportStageReport,
  ListFacesReport,
  OpenDatasetReport,
} from "./types";

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
  });

export const setAnnotations = async (
  datasetRoot: string,
  faceId: string,
  edits: AnnotationEdit[]
) =>
  invoke<AnnotationEdit[]>("set_annotations_command", {
    request: { datasetRoot, faceId, edits },
  });

export const exportCoco = async (options: ExportCocoOptions) =>
  invoke<ExportCocoReport>("export_coco_command", { request: options });

export const generateReviewDataset = async (options: GenerateReviewDatasetOptions) =>
  invoke<GenerateReviewDatasetReport>("generate_review_dataset_command", {
    request: options,
  });

export const extractFramesFromMp4 = async (options: ExtractFramesFromMp4Options) =>
  invoke<ExtractFramesFromMp4Report>("extract_frames_from_mp4_command", {
    request: options,
  });
