// Color + label for a user's fairness score (0–100, where 50 = neutral).
// The score is a credit/debt balance: 50 is the natural resting point, so it
// should read as neutral — not "bad". Below 50 trends warm (yellow → red),
// above 50 trends green.

export function fairnessColor(score) {
  if (score >= 75) return '#22c55e'; // optimal green — strong credit
  if (score >= 50) return '#84cc16'; // lime — at or above neutral
  if (score >= 30) return '#eab308'; // amber — below neutral
  return '#ef4444';                  // red — in significant debt
}

export function fairnessLabel(score) {
  if (score >= 75) return 'Excellent';
  if (score >= 50) return 'Good';
  if (score >= 30) return 'Below average';
  return 'Needs attention';
}
