import { ClassifierService } from '../classifier';
import { AIService } from '../ai';

describe('ClassifierService', () => {
  let classifierService: ClassifierService;
  let mockAIService: jest.Mocked<AIService>;

  beforeEach(() => {
    mockAIService = {
      generateObject: jest.fn(),
      generateText: jest.fn()
    } as any;

    classifierService = new ClassifierService(mockAIService);
  });

  describe('heuristicIntent', () => {
    it('should detect summary intent from keywords', () => {
      const mention = {
        mentionId: 'test-1',
        postId: 'post-1',
        authorId: 'user-1',
        content: 'Can you provide a summary of this thread?',
        receivedAt: '2023-01-01T00:00:00Z',
        status: 'received' as const
      };

      const result = classifierService.heuristicIntent(mention);

      expect(result).toBeTruthy();
      expect(result?.intent).toBe('summary');
      expect(result?.confidence).toBeGreaterThan(0.4);
      expect(result?.matchedKeywords).toContain('summary');
    });

    it('should detect factcheck intent from keywords', () => {
      const mention = {
        mentionId: 'test-2',
        postId: 'post-2',
        authorId: 'user-2',
        content: 'Can you fact check this claim about climate change?',
        receivedAt: '2023-01-01T00:00:00Z',
        status: 'received' as const
      };

      const result = classifierService.heuristicIntent(mention);

      expect(result).toBeTruthy();
      expect(result?.intent).toBe('factcheck');
      expect(result?.confidence).toBeGreaterThan(0.5);
      expect(result?.matchedKeywords).toContain('fact check');
    });

    it('should prioritize factcheck over summary', () => {
      const mention = {
        mentionId: 'test-3',
        postId: 'post-3',
        authorId: 'user-3',
        content: 'Can you fact check this and then provide a summary?',
        receivedAt: '2023-01-01T00:00:00Z',
        status: 'received' as const
      };

      const result = classifierService.heuristicIntent(mention);

      expect(result).toBeTruthy();
      expect(result?.intent).toBe('factcheck');
    });

    it('should return null for unrecognized content', () => {
      const mention = {
        mentionId: 'test-4',
        postId: 'post-4',
        authorId: 'user-4',
        content: 'Hello, how are you doing today?',
        receivedAt: '2023-01-01T00:00:00Z',
        status: 'received' as const
      };

      const result = classifierService.heuristicIntent(mention);

      expect(result).toBeNull();
    });
  });

  describe('routeMention', () => {
    it('should use heuristics for high confidence matches', async () => {
      const mention = {
        mentionId: 'test-5',
        postId: 'post-5',
        authorId: 'user-5',
        content: 'Please summarize this discussion for me',
        receivedAt: '2023-01-01T00:00:00Z',
        status: 'received' as const
      };

      const result = await classifierService.routeMention(mention);

      expect(result.intent).toBe('summary');
      expect(result.method).toBe('heuristic');
      expect(result.confidence).toBeGreaterThan(0.6);
      expect(mockAIService.generateObject).not.toHaveBeenCalled();
    });

    it('should fallback to LLM for low confidence heuristics', async () => {
      mockAIService.generateObject.mockResolvedValue({
        object: {
          intent: 'factcheck',
          confidence: 0.8,
          reason: 'User wants to verify claims'
        },
        usage: { totalTokens: 50 }
      });

      const mention = {
        mentionId: 'test-6',
        postId: 'post-6',
        authorId: 'user-6',
        content: 'What do you think about this information?',
        receivedAt: '2023-01-01T00:00:00Z',
        status: 'received' as const
      };

      const result = await classifierService.routeMention(mention);

      expect(result.intent).toBe('factcheck');
      expect(result.method).toBe('llm');
      expect(result.confidence).toBe(0.8);
      expect(mockAIService.generateObject).toHaveBeenCalled();
    });
  });
});