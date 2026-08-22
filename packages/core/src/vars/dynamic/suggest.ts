const MAX_SUGGESTIONS = 5;
const MAX_DISTANCE = 4;

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + substitutionCost,
      );
    }
    previous = current;
  }

  return previous[right.length] ?? 0;
}

export function nearestNames(name: string, candidates: string[]): string[] {
  const normalizedName = name.toLowerCase();
  return candidates
    .map((candidate) => ({ candidate, distance: editDistance(normalizedName, candidate.toLowerCase()) }))
    .filter(({ distance }) => distance <= MAX_DISTANCE)
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ candidate }) => candidate);
}
