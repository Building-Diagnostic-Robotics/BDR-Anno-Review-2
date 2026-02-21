export type AnnotationEdit = {
  bbox: [number, number, number, number];
  provenance: {
    source: string;
    updatedAt: string;
    sourceAnnotationId?: number;
  };
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
  sourceFramesDir: string;
  generatedAt: string;
  faces: string[];
  renderSize: number;
  horizontalFovDegrees: number;
  minProjectedBoxArea: number;
};

export type GenerateReviewDatasetReport = {
  writtenManifestPath: string;
  faceCount: number;
  filteredBoxCount: number;
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
