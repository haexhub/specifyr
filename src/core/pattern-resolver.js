export class PatternResolver {
  constructor(map = {}) {
    this.map = map;
  }

  resolve(stage, context) {
    const rawName = this.map[stage] ?? "generic";
    const name = rawName.startsWith("fabric:") ? rawName : `fabric:${rawName}`;
    return {
      name,
      context
    };
  }
}
