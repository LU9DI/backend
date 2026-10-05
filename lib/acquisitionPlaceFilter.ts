/**
 * Filtro de qualificação da busca no Google Places: só entram empresas mal
 * avaliadas ou subavaliadas. Configurável por ACQUISITION_MAX_RATING (padrão 4.2)
 * e ACQUISITION_MIN_REVIEWS (padrão 20, para a nota ser estatisticamente relevante).
 */
export function isUnderratedPlace(place: any): boolean {
  const maxRating = Number(process.env.ACQUISITION_MAX_RATING || 4.2);
  const minReviews = Number(process.env.ACQUISITION_MIN_REVIEWS || 20);
  const rating = Number(place?.rating || 0);
  const reviews = Number(place?.userRatingCount || 0);
  if (!(rating > 0) || reviews < minReviews) return false;
  return rating <= maxRating;
}
