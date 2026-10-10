/**
 * 閉場後materializationと翌日AI予測が共有する、学習snapshotの世代契約。
 * 日次予測serviceと学習serviceの実行時循環importを避けるため、値定数だけを分離する。
 */
export const AI_FORECAST_LEARNING_MODEL_VERSION = "ai-forecast-learning-v2";
export const AI_FORECAST_LEARNING_SCHEMA_VERSION =
  "ai-forecast-learning-application-v4";
