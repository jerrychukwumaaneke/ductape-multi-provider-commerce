import { ValidationError } from '../../common/errors/app-error.js';

export interface RenderResult {
  subject?: string;
  body: string;
}

export class TemplateEngine {
  public static validateVariables(requiredVars: string[], providedVars: Record<string, unknown>): void {
    const missing: string[] = [];
    for (const v of requiredVars) {
      if (providedVars[v] === undefined || providedVars[v] === null) {
        missing.push(v);
      }
    }

    if (missing.length > 0) {
      throw new ValidationError(
        `Template missing required variable(s): ${missing.join(', ')}`,
        { missingVariables: missing }
      );
    }
  }

  public static interpolate(text: string, vars: Record<string, unknown>): string {
    return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
      const val = vars[key];
      return val !== undefined && val !== null ? String(val) : match;
    });
  }

  public static render(
    template: { subject?: string | null; body: string; required_vars: string[] },
    vars: Record<string, unknown>
  ): RenderResult {
    this.validateVariables(template.required_vars, vars);

    return {
      subject: template.subject ? this.interpolate(template.subject, vars) : undefined,
      body: this.interpolate(template.body, vars),
    };
  }
}
