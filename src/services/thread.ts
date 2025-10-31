import { ThreadContext, ThreadValidation } from '@/types/thread';
import { Post } from '@/types/mention';
import { PubkyService } from './pubky';
import logger from '@/utils/logger';
import { extractKeywords } from '@/utils/text';

export class ThreadService {
  constructor(private pubkyService: PubkyService) {}

  async buildThreadContext(
    rootPostId: string,
    maxDepth: number = 5
  ): Promise<ThreadContext> {
    try {
      logger.debug('Building thread context', { rootPostId, maxDepth });

      // Get root post
      const rootPost = await this.pubkyService.getPostById(rootPostId);
      if (!rootPost) {
        throw new Error(`Root post not found: ${rootPostId}`);
      }

      // Get all posts in thread
      const allPosts = await this.pubkyService.buildThreadPosts(rootPostId, maxDepth);
      const posts = [rootPost, ...allPosts];

      // Extract participants
      const participants = [...new Set(posts.map(p => p.authorId))];

      // Calculate token count (rough estimation)
      const totalTokens = posts.reduce((sum, post) => {
        return sum + Math.ceil(post.content.length / 4); // Rough token estimation
      }, 0);

      // Extract topics from content
      const allContent = posts.map(p => p.content).join(' ');
      const topics = extractKeywords(allContent);

      // Determine completeness
      const isComplete = posts.length < 100; // Assume complete if under limit

      const context: ThreadContext = {
        rootPost,
        posts,
        participants,
        depth: maxDepth,
        totalTokens,
        isComplete,
        metadata: {
          topics: topics.slice(0, 5), // Top 5 topics
          complexity: this.calculateComplexity(posts),
          sentiment: 'neutral' // Placeholder
        }
      };

      logger.debug('Thread context built', {
        postCount: posts.length,
        participants: participants.length,
        totalTokens,
        isComplete
      });

      return context;

    } catch (error) {
      logger.error('Failed to build thread context:', error);
      throw error;
    }
  }

  validate(context: ThreadContext): ThreadValidation {
    const issues: string[] = [];
    const warnings: string[] = [];
    const recommendations: string[] = [];

    // Check completeness
    if (!context.isComplete) {
      issues.push('Thread context is incomplete');
    }

    // Check token count
    if (context.totalTokens > 4000) {
      warnings.push('Thread exceeds recommended token limit');
      recommendations.push('Consider summarizing earlier posts');
    }

    // Check depth
    if (context.depth > 10) {
      warnings.push('Thread depth is very high');
      recommendations.push('Focus on most recent posts');
    }

    // Check participant count
    if (context.participants.length > 10) {
      warnings.push('Many participants in thread');
      recommendations.push('Identify key conversation participants');
    }

    const isComplete = issues.length === 0;

    return {
      isComplete,
      issues,
      warnings,
      recommendations
    };
  }

  private calculateComplexity(posts: Post[]): number {
    // Simple complexity calculation based on:
    // - Number of posts
    // - Average content length
    // - Number of participants

    const avgLength = posts.reduce((sum, p) => sum + p.content.length, 0) / posts.length;
    const participants = new Set(posts.map(p => p.authorId)).size;

    let complexity = 0;

    // Post count factor
    if (posts.length > 20) complexity += 0.4;
    else if (posts.length > 10) complexity += 0.2;

    // Length factor
    if (avgLength > 500) complexity += 0.3;
    else if (avgLength > 200) complexity += 0.15;

    // Participant factor
    if (participants > 5) complexity += 0.3;
    else if (participants > 2) complexity += 0.15;

    return Math.min(complexity, 1.0);
  }

  async getPostsByIds(postIds: string[]): Promise<Post[]> {
    const posts: Post[] = [];

    for (const postId of postIds) {
      try {
        const post = await this.pubkyService.getPostById(postId);
        if (post) {
          posts.push(post);
        }
      } catch (error) {
        logger.warn(`Failed to fetch post ${postId}:`, error);
      }
    }

    return posts;
  }
}