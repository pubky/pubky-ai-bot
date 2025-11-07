import { ThreadContext, ThreadValidation } from '@/types/thread';
import { Post } from '@/types/mention';
import { PubkyService } from './pubky';
import logger from '@/utils/logger';
import { extractKeywords } from '@/utils/text';

export class ThreadService {
  private cache: Map<string, Post> = new Map();
  private visited: Set<string> = new Set();

  constructor(private pubkyService: PubkyService) {}

  /**
   * Build thread context from a mention post URI
   * Fetches parents recursively and builds complete conversation thread
   */
  async buildThreadContext(
    mentionPostUri: string,
    options: {
      maxDepth?: number;
      maxPosts?: number;
      includeParents?: boolean;
    } = {}
  ): Promise<ThreadContext> {
    try {
      const maxDepth = options.maxDepth || 50;
      const maxPosts = options.maxPosts || 500;
      const includeParents = options.includeParents !== false;

      logger.debug('Building thread context', {
        mentionPostUri,
        maxDepth,
        maxPosts,
        includeParents
      });

      // Reset state
      this.cache.clear();
      this.visited.clear();

      // Fetch the mention post
      const mentionPost = await this.fetchPost(mentionPostUri);
      if (!mentionPost) {
        throw new Error(`Failed to fetch mention post: ${mentionPostUri}`);
      }

      const posts: Post[] = [mentionPost];

      // Build upward (fetch parents)
      if (includeParents && mentionPost.parentUri) {
        logger.debug('Fetching parent posts...');
        const parents = await this.fetchParents(mentionPost, maxDepth);
        posts.push(...parents);
      }

      // Sort posts chronologically
      posts.sort((a, b) => {
        const timeA = new Date(a.createdAt).getTime();
        const timeB = new Date(b.createdAt).getTime();
        return timeA - timeB;
      });

      // Find root post (earliest post without parent)
      const rootPost = this.findRootPost(posts);

      // Extract participants
      const participants = [...new Set(posts.map(p => p.authorId))];

      // Calculate token count (rough estimation)
      const totalTokens = posts.reduce((sum, post) => {
        return sum + Math.ceil(post.content.length / 4); // Rough token estimation
      }, 0);

      // Extract topics from content
      const allContent = posts.map(p => p.content).join(' ');
      const topics = extractKeywords(allContent);

      // Calculate actual depth
      const depth = Math.max(...posts.map(p => this.calculatePostDepth(p, posts)));

      // Determine completeness
      const isComplete = posts.length < maxPosts;

      const context: ThreadContext = {
        rootPost,
        posts,
        participants,
        depth,
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
        depth,
        totalTokens,
        isComplete
      });

      return context;

    } catch (error) {
      logger.error('Failed to build thread context:', error);
      throw error;
    }
  }

  /**
   * Fetch a single post with caching
   */
  private async fetchPost(postUri: string): Promise<Post | null> {
    // Check cache
    if (this.cache.has(postUri)) {
      return this.cache.get(postUri)!;
    }

    // Check if already visited (prevent cycles)
    if (this.visited.has(postUri)) {
      return null;
    }

    this.visited.add(postUri);

    try {
      const post = await this.pubkyService.getPost(postUri);
      if (post) {
        this.cache.set(postUri, post);
      }
      return post;
    } catch (error) {
      logger.error(`Failed to fetch post ${postUri}:`, error);
      return null;
    }
  }

  /**
   * Fetch all parent posts recursively up the thread
   */
  private async fetchParents(post: Post, maxDepth: number): Promise<Post[]> {
    const parents: Post[] = [];
    const visitedParents = new Set<string>(); // Detect circular references
    let currentPost = post;
    let depth = 1;

    while (currentPost.parentUri && depth <= maxDepth) {
      // Check for circular reference
      if (visitedParents.has(currentPost.parentUri)) {
        logger.warn(`Circular parent reference detected at depth ${depth}`);
        break;
      }
      visitedParents.add(currentPost.parentUri);

      // Show progress for deep threads
      if (depth > 1 && depth % 10 === 0) {
        logger.debug(`Fetching parent ${depth}/${maxDepth}...`);
      }

      const parent = await this.fetchPost(currentPost.parentUri);
      if (!parent) break;

      parents.push(parent);
      currentPost = parent;
      depth++;
    }

    // Warn if we hit the depth limit
    if (depth > maxDepth && currentPost.parentUri) {
      logger.warn(`Thread exceeds maxDepth (${maxDepth}), some parents not fetched`);
    }

    if (parents.length > 0) {
      logger.debug(`Fetched ${parents.length} parent post(s)`);
    }

    return parents;
  }

  /**
   * Find the root post in a thread (post without parent or earliest)
   */
  private findRootPost(posts: Post[]): Post {
    // Find post with no parent
    const postsWithoutParent = posts.filter(p => !p.parentUri);
    if (postsWithoutParent.length > 0) {
      // Return earliest post without parent
      return postsWithoutParent.reduce((earliest, current) => {
        const earliestTime = new Date(earliest.createdAt).getTime();
        const currentTime = new Date(current.createdAt).getTime();
        return currentTime < earliestTime ? current : earliest;
      });
    }

    // If all posts have parents, return earliest post
    return posts.reduce((earliest, current) => {
      const earliestTime = new Date(earliest.createdAt).getTime();
      const currentTime = new Date(current.createdAt).getTime();
      return currentTime < earliestTime ? current : earliest;
    });
  }

  /**
   * Calculate depth of a post in the thread
   */
  private calculatePostDepth(post: Post, allPosts: Post[]): number {
    let depth = 0;
    let currentPost = post;

    while (currentPost.parentUri) {
      depth++;
      const parent = allPosts.find(p => p.uri === currentPost.parentUri);
      if (!parent) break;
      currentPost = parent;
    }

    return depth;
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