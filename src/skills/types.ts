export interface SkillMetadata {
  name: string;
  description: string;
  version: string;
  triggers?: string[]; // Regex patterns that activate this skill
  agentTypes?: string[]; // Default for these agent types
  dependencies?: string[]; // Other skill names
}

export interface Skill {
  metadata: SkillMetadata;
  content: string; // The SKILL.md body text
  sourcePath: string;
}
