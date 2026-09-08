export function honestNoteForRating(rating: number): string {
  const notes: Record<number, string> = {
    0: 'Terrível',
    1: 'Muito ruim',
    2: 'Ruim',
    3: 'Regular',
    4: 'Bom',
    5: 'Excelente',
  };
  const r = Math.max(0, Math.min(5, Math.round(rating)));
  return notes[r] ?? '';
}
