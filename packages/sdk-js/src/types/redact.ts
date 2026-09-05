export type RedactConfig = {
  preset?: 'default' | 'none';
  custom?: RegExp[];
  fields?: string[];
};

export type RedactResult = { value: unknown; map: Record<string, string> };
