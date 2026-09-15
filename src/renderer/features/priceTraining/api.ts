import type { PriceTrainingContract } from "../../../shared/priceTraining.js";
import { createFeatureApi } from "../../services/featureApi";

export function getPriceTrainingApi() {
  return createFeatureApi<PriceTrainingContract>();
}
