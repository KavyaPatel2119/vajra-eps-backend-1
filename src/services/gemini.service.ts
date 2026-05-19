import { GoogleGenerativeAI } from '@google/generative-ai';
import logger from '../config/logger';

/**
 * Gemini AI Service for Quiz Generation
 * Generates structured questions from uploaded materials
 */

interface GeneratedQuestion {
  type: 'MCQ' | 'MSQ' | 'SHORT' | 'LONG' | 'PRACTICAL';
  questionText: string;
  options?: string[];
  correctAnswerIndex?: number[];
  correctAnswer?: string;
  explanation?: string;
  marks: number;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
}

interface QuizGenerationRequest {
  materialText: string;
  questionCount: number;
  types?: string[];
  difficulty?: string;
}

interface QuizGenerationResponse {
  questions: GeneratedQuestion[];
  totalMarks: number;
  generatedAt: Date;
  model: string;
}

export class GeminiService {
  private client: GoogleGenerativeAI;
  private model: any;
  private currentModelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  private readonly maxQuestionsPerRequest = 10;
  private readonly maxConcurrentGenerations = Math.max(
    1,
    Math.min(3, Number(process.env.GEMINI_MAX_CONCURRENT_GENERATIONS || 1))
  );
  private readonly fallbackModels = [
    'gemini-2.5-flash',
  ];

  constructor() {
    this.client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
    this.model = this.client.getGenerativeModel({
      model: this.currentModelName,
    });

    logger.info('✅ Gemini Service initialized');
  }

  /**
   * Generate quiz from material text
   */
  async generateQuiz(request: QuizGenerationRequest): Promise<QuizGenerationResponse> {
    try {
      const { materialText, questionCount, types = ['MCQ', 'SHORT'], difficulty = 'MIXED' } = request;
      const normalizedCount = Math.max(1, Math.min(100, Number(questionCount) || 5));
      const questions: GeneratedQuestion[] = [];
      const batches = this.buildQuestionBatches(normalizedCount, types);

      const initialResults = await this.runLimited(
        batches,
        this.maxConcurrentGenerations,
        (batch, index) => this.generateQuestionBatch(materialText, batch.questionCount, batch.types, difficulty, index + 1, batches.length, [])
      );

      for (const batchQuestions of initialResults) {
        this.pushUniqueQuestions(questions, batchQuestions, normalizedCount);
      }

      let retry = 0;
      while (questions.length < normalizedCount && retry < 4) {
        retry += 1;
        const remaining = normalizedCount - questions.length;
        const retryCount = Math.min(this.maxQuestionsPerRequest, remaining);
        const refill = await this.generateQuestionBatch(
          materialText,
          retryCount,
          types,
          difficulty,
          batches.length + retry,
          batches.length + 4,
          questions.map((q) => q.questionText)
        );
        this.pushUniqueQuestions(questions, refill, normalizedCount);
      }

      if (questions.length < normalizedCount) {
        logger.warn(`Gemini generated ${questions.length} of ${normalizedCount}; filling remaining questions from material-derived templates`);
        this.pushUniqueQuestions(
          questions,
          this.buildMaterialFallbackQuestions(materialText, normalizedCount - questions.length, types, difficulty),
          normalizedCount
        );
      }

      const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0);

      logger.info(
        `✅ Generated ${questions.length} questions with total marks: ${totalMarks}`
      );

      return {
        questions: questions.slice(0, normalizedCount),
        totalMarks,
        generatedAt: new Date(),
        model: this.currentModelName,
      };
    } catch (error) {
      logger.error('❌ Quiz generation failed:', error);
      throw error;
    }
  }

  private async generateQuestionBatch(
    materialText: string,
    questionCount: number,
    types: string[],
    difficulty: string,
    batchNumber: number,
    totalBatches: number,
    previousQuestions: string[]
  ): Promise<GeneratedQuestion[]> {
    const prompt = this.buildPrompt(materialText, questionCount, types, difficulty, batchNumber, totalBatches, previousQuestions);
    const result = await this.generateWithFallback(prompt, this.maxOutputTokensFor(questionCount));
    return this.parseQuestions(result.response.text()).slice(0, questionCount);
  }

  private async runLimited<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    let nextIndex = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await worker(items[index], index);
        } catch (error) {
          logger.warn(`Gemini batch ${index + 1} failed`, error);
          results[index] = [] as unknown as R;
        }
      }
    });
    await Promise.all(runners);
    return results;
  }

  private pushUniqueQuestions(target: GeneratedQuestion[], incoming: GeneratedQuestion[], maxCount: number) {
    for (const question of incoming) {
      if (target.length >= maxCount) return;
      if (!target.some((existing) => this.sameQuestion(existing.questionText, question.questionText))) {
        target.push(question);
      }
    }
  }

  private async generateWithFallback(prompt: string, maxOutputTokens = 8192): Promise<any> {
    const generationConfig = {
      responseMimeType: 'application/json',
      temperature: 0.25,
      maxOutputTokens,
    };

    try {
      return await this.model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
      });
    } catch (error: any) {
      const message = String(error?.message || '');
      const isModelNotFound = message.includes('404') || message.includes('not found for API version');
      const isQuotaOrRateLimited = message.includes('429') || /quota|rate.?limit|too many requests/i.test(message);
      if (isQuotaOrRateLimited) {
        const retryMs = this.parseRetryDelayMs(message);
        if (retryMs > 0 && retryMs <= 65000) {
          logger.warn(`Gemini quota/rate limit hit on ${this.currentModelName}; waiting ${Math.ceil(retryMs / 1000)}s before fallback`);
          await this.sleep(retryMs + 1000);
        }
      }
      if (!isModelNotFound && !isQuotaOrRateLimited) {
        throw error;
      }

      const availableModels = await this.fetchAvailableModels();
      const modelCandidates = [...new Set([...this.fallbackModels, ...availableModels])].filter(
        (modelName) => modelName !== this.currentModelName
      );
      for (const modelName of modelCandidates) {
        try {
          const model = this.client.getGenerativeModel({ model: modelName });
          const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig,
          });
          this.model = model;
          this.currentModelName = modelName;
          logger.warn(`⚠️ Switched Gemini model to ${modelName}`);
          return result;
        } catch (fallbackError: any) {
          const fallbackMessage = String(fallbackError?.message || '');
          if (/429|quota|rate.?limit|too many requests/i.test(fallbackMessage)) {
            logger.warn(`Gemini model ${modelName} is quota/rate limited; trying next model`);
          }
        }
      }

      throw error;
    }
  }

  private parseRetryDelayMs(message: string): number {
    const retryInfo = message.match(/retryDelay"\s*:\s*"(\d+)s"/i);
    if (retryInfo) return Number(retryInfo[1]) * 1000;
    const retryText = message.match(/retry in\s+([\d.]+)s/i);
    if (retryText) return Math.ceil(Number(retryText[1]) * 1000);
    return 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetchAvailableModels(): Promise<string[]> {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return [];
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!res.ok) return [];
      const payload: any = await res.json();
      const models: any[] = payload?.models || [];
      return models
        .filter((m) => Array.isArray(m?.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => String(m.name || ''))
        .filter(Boolean)
        .map((name) => name.replace(/^models\//, ''));
    } catch {
      return [];
    }
  }

  /**
   * Generate MCQ questions specifically
   */
  async generateMCQ(
    materialText: string,
    count: number = 5
  ): Promise<GeneratedQuestion[]> {
    const response = await this.generateQuiz({
      materialText,
      questionCount: count,
      types: ['MCQ'],
    });

    return response.questions.filter((q) => q.type === 'MCQ');
  }

  /**
   * Generate coding/practical questions
   */
  async generatePracticalQuestions(
    topic: string,
    count: number = 3
  ): Promise<GeneratedQuestion[]> {
    try {
      const prompt = `Generate ${count} practical coding/implementation questions for the topic: "${topic}"

Each question should:
1. Have practical, real-world applicability
2. Test understanding and implementation skills
3. Include detailed expected solution outline
4. Have marks assigned (10-20 marks each)

Format as JSON array with fields: questionText, correctAnswer, marks, difficulty`;

      const result = await this.model.generateContent(prompt);
      const responseText = result.response.text();

      const questions = this.parseQuestions(responseText);

      return questions.filter((q) => q.type === 'PRACTICAL' || q.type === 'LONG');
    } catch (error) {
      logger.error('❌ Practical question generation failed:', error);
      throw error;
    }
  }

  /**
   * Build prompt for quiz generation
   */
  private buildPrompt(
    materialText: string,
    questionCount: number,
    types: string[],
    difficulty: string,
    batchNumber = 1,
    totalBatches = 1,
    previousQuestions: string[] = []
  ): string {
    const boundedMaterial = this.compactMaterial(materialText);
    const previousQuestionBlock =
      previousQuestions.length > 0
        ? `\nAVOID DUPLICATING THESE ALREADY GENERATED QUESTIONS:\n${previousQuestions
            .slice(-30)
            .map((question, index) => `${index + 1}. ${question}`)
            .join('\n')}\n`
        : '';

    return `
You are an expert examination question generator for educational institutions.

Generate exactly ${questionCount} questions from the following material.
This is batch ${batchNumber} of ${totalBatches}; return only this batch.

MATERIAL:
${boundedMaterial}
${previousQuestionBlock}

REQUIREMENTS:
1. Question Types (use ONLY these): ${types.join(', ')}
2. Difficulty Level: ${difficulty}
3. Use ONLY the provided material. Do not invent external topics.
4. If user instruction mentions a unit/topic (e.g., "Unit 1"), restrict questions strictly to that section.
5. When MORE THAN ONE type is listed, spread questions across types as evenly as possible (each listed type must appear at least once if ${questionCount} is greater than or equal to the number of types).
6. For MCQ: 4 short options, single correct — use "correctAnswerIndex": [oneIndex]
7. For MSQ: 4 short options, multiple correct — use "correctAnswerIndex": [0,2] (array with 2+ indices when possible)
8. For SHORT: no options; use "correctAnswer": "expected short text (2-3 sentences)"
9. For LONG: no options; use "correctAnswer": "expected paragraph"
10. Hard questions should test application, comparison, edge cases, or reasoning from the material, but must still be answerable from the material.
11. Keep question text, options, and answers concise. Do not include explanation unless it is essential.

RESPONSE FORMAT:
Respond ONLY with valid JSON array. No markdown, no explanations.

[
  {
    "type": "MCQ",
    "questionText": "...",
    "options": ["A", "B", "C", "D"],
    "correctAnswerIndex": [0],
    "marks": 1,
    "difficulty": "EASY"
  },
  {
    "type": "MSQ",
    "questionText": "...",
    "options": ["A", "B", "C", "D"],
    "correctAnswerIndex": [0, 2],
    "marks": 2,
    "difficulty": "MEDIUM"
  },
  {
    "type": "SHORT",
    "questionText": "...",
    "correctAnswer": "Expected answer in 2-3 sentences.",
    "marks": 2,
    "difficulty": "MEDIUM"
  },
  ...
]

Ensure:
- JSON is valid and parseable
- Each question is distinct and from the material
- Marks are appropriate to difficulty
`;
  }

  private buildQuestionBatches(questionCount: number, types: string[]): Array<{ questionCount: number; types: string[] }> {
    const batches: Array<{ questionCount: number; types: string[] }> = [];
    let remaining = questionCount;
    while (remaining > 0) {
      const count = Math.min(this.maxQuestionsPerRequest, remaining);
      batches.push({ questionCount: count, types });
      remaining -= count;
    }
    return batches;
  }

  private maxOutputTokensFor(questionCount: number): number {
    return Math.min(16000, Math.max(4096, questionCount * 900));
  }

  private sameQuestion(a: string, b: string): boolean {
    const normalize = (value: string) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return normalize(a) === normalize(b);
  }

  private compactMaterial(materialText: string): string {
    const normalized = String(materialText || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const maxChars = 45000;
    if (normalized.length <= maxChars) return normalized;
    const head = normalized.slice(0, Math.floor(maxChars * 0.7));
    const tail = normalized.slice(-Math.floor(maxChars * 0.3));
    return `${head}\n\n[...material shortened for generation...]\n\n${tail}`;
  }

  private buildMaterialFallbackQuestions(
    materialText: string,
    count: number,
    types: string[],
    difficulty: string
  ): GeneratedQuestion[] {
    const sentences = String(materialText || '')
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length >= 40);
    const pool = sentences.length > 0 ? sentences : [String(materialText || 'the supplied material').slice(0, 220)];
    const normalizedTypes = types.length > 0 ? types : ['MCQ'];
    const requestedHard = /HARD|TOUGH|DIFFICULT|ADVANCED/i.test(String(difficulty || ''));

    return Array.from({ length: Math.max(0, count) }, (_, index) => {
      const source = pool[index % pool.length];
      const type = normalizedTypes[index % normalizedTypes.length] as GeneratedQuestion['type'];
      const baseDifficulty = requestedHard ? 'HARD' : (String(difficulty).toUpperCase() === 'EASY' ? 'EASY' : 'MEDIUM');
      const stem = requestedHard
        ? `Apply the concept from the material to identify the most defensible conclusion: ${source}`
        : `Based on the material, answer this question: ${source}`;

      if (type === 'MCQ' || type === 'MSQ') {
        return {
          type: type === 'MSQ' ? 'MSQ' : 'MCQ',
          questionText: `${stem}`,
          options: [
            'The statement is directly supported by the material',
            'The statement contradicts the material',
            'The material does not discuss this concept',
            'The statement is unrelated to the supplied topic',
          ],
          correctAnswerIndex: type === 'MSQ' ? [0] : [0],
          marks: requestedHard ? 2 : 1,
          difficulty: baseDifficulty as GeneratedQuestion['difficulty'],
        };
      }

      return {
        type: type === 'PRACTICAL' ? 'PRACTICAL' : type === 'LONG' ? 'LONG' : 'SHORT',
        questionText: requestedHard
          ? `Explain the implication, limitation, or edge case represented in this material excerpt: ${source}`
          : `Summarize the key idea represented in this material excerpt: ${source}`,
        correctAnswer: source,
        marks: requestedHard ? 5 : 2,
        difficulty: baseDifficulty as GeneratedQuestion['difficulty'],
      };
    });
  }

  /**
   * Parse JSON questions from response
   */
  private parseQuestions(responseText: string): GeneratedQuestion[] {
    try {
      // Extract JSON from response (handle markdown)
      let jsonStr = responseText;

      // Remove markdown code blocks if present
      const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }
      if (!jsonStr.trim().startsWith('[')) {
        const start = jsonStr.indexOf('[');
        const end = jsonStr.lastIndexOf(']');
        if (start >= 0 && end > start) {
          jsonStr = jsonStr.slice(start, end + 1);
        }
      }

      const questions: GeneratedQuestion[] = JSON.parse(jsonStr);

      // Validate and clean questions
      return questions
        .filter((q): q is GeneratedQuestion => {
          return Boolean(
            q.questionText &&
            q.type &&
            ['MCQ', 'MSQ', 'SHORT', 'LONG', 'PRACTICAL'].includes(q.type)
          );
        })
        .map((q) => ({
          ...q,
          correctAnswerIndex:
            Array.isArray(q.correctAnswerIndex)
              ? q.correctAnswerIndex
              : q.correctAnswerIndex == null
                ? undefined
                : [Number(q.correctAnswerIndex)].filter((n) => Number.isFinite(n)),
          marks: q.marks || 1,
          difficulty: q.difficulty || 'MEDIUM',
          type: q.type as 'MCQ' | 'MSQ' | 'SHORT' | 'LONG' | 'PRACTICAL',
        }));
    } catch (error) {
      logger.error('❌ JSON parsing failed:', error);
      logger.debug('Response text:', responseText);
      throw new Error('Failed to parse generated questions');
    }
  }

  /**
   * Validate generated questions
   */
  validateQuestions(questions: GeneratedQuestion[]): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    questions.forEach((q, index) => {
      if (!q.questionText) {
        errors.push(`Question ${index + 1}: Missing question text`);
      }

      if (!q.type) {
        errors.push(`Question ${index + 1}: Missing question type`);
      }

      if (q.type === 'MCQ' && (!q.options || q.options.length < 2)) {
        errors.push(
          `Question ${index + 1}: MCQ must have at least 2 options`
        );
      }

      if (
        q.type === 'MCQ' &&
        q.correctAnswerIndex === undefined &&
        q.correctAnswer === undefined
      ) {
        errors.push(`Question ${index + 1}: MCQ missing correct answer`);
      }

      if (q.type === 'MSQ') {
        const idx = q.correctAnswerIndex as unknown;
        const hasMulti =
          Array.isArray(idx) ? idx.length >= 1 : idx !== undefined && idx !== null && String(idx) !== '';
        if (!q.options || q.options.length < 2 || !hasMulti) {
          errors.push(`Question ${index + 1}: MSQ must have options and at least one correct index in correctAnswerIndex`);
        }
      }

      if ((q.type === 'SHORT' || q.type === 'LONG') && !q.correctAnswer) {
        errors.push(`Question ${index + 1}: Missing answer for ${q.type}`);
      }

      const marks = q.marks ?? 1;
      if (marks < 1 || marks > 50) {
        errors.push(
          `Question ${index + 1}: Marks must be between 1 and 50 (got ${marks})`
        );
      }
    });

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Regenerate specific question if quality is poor
   */
  async regenerateQuestion(
    originalQuestion: GeneratedQuestion,
    materialContext: string
  ): Promise<GeneratedQuestion> {
    try {
      const prompt = `The following generated question needs improvement:

Original Question: ${JSON.stringify(originalQuestion)}

Material Context: ${materialContext}

Please regenerate this question to be:
1. Clearer and more specific
2. Better aligned with the material
3. Properly formatted

Return ONLY valid JSON for the single improved question.`;

      const result = await this.model.generateContent(prompt);
      const responseText = result.response.text();

      const questions = this.parseQuestions(responseText);

      return questions[0] || originalQuestion;
    } catch (error) {
      logger.error('❌ Question regeneration failed:', error);
      return originalQuestion;
    }
  }

  /**
   * Extract key topics from material
   */
  async extractTopics(materialText: string): Promise<string[]> {
    try {
      const prompt = `Extract the top 10 key topics/concepts from this material:

${materialText}

Respond with ONLY a JSON array of strings, no markdown:
["topic1", "topic2", ...]`;

      const result = await this.model.generateContent(prompt);
      const responseText = result.response.text();

      return JSON.parse(responseText);
    } catch (error) {
      logger.error('❌ Topic extraction failed:', error);
      return [];
    }
  }

  /**
   * Get Gemini service health
   */
  async getHealth(): Promise<boolean> {
    try {
      const result = await this.model.generateContent('Say "healthy" in one word.');
      return result.response.text().toLowerCase().includes('healthy');
    } catch (error) {
      logger.error('❌ Gemini health check failed:', error);
      return false;
    }
  }
}

export const geminiService = new GeminiService();
