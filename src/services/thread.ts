import { ThreadContext, ThreadValidation, ThreadParticipant } from '@/types/thread';
import { Post } from '@/types/mention';
import { PubkyService } from './pubky';
import logger from '@/utils/logger';
import { extractKeywords } from '@/utils/text';
import appConfig from '@/config';
import { db } from '@/infrastructure/database/connection';

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
      mentionId?: string;  // Add mentionId to track deleted posts
    } = {}
  ): Promise<ThreadContext> {
    try {
      // Use limits from configuration (can be overridden by env variables)
      const maxDepth = options.maxDepth || appConfig.limits.thread.maxDepth;
      const maxPosts = options.maxPosts || appConfig.limits.thread.maxPosts;
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
      const mentionPost = await this.fetchPost(mentionPostUri, options.mentionId);
      if (!mentionPost) {
        // Post is not available - could be deleted, network error, or other issue
        // We don't automatically assume it's deleted to avoid false positives
        throw new Error(`Post not available: ${mentionPostUri}`);
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

      // Resolve participant profiles with usernames
      const participantProfiles = await this.resolveParticipantProfiles(participants);

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
        participantProfiles, // Include resolved usernames
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
   * Check if a post is already marked as deleted in the database
   */
  private async isPostDeleted(postUri: string): Promise<boolean> {
    try {
      const result = await db.query(
        'SELECT id FROM deleted_posts WHERE post_uri = $1',
        [postUri]
      );
      return result.length > 0;
    } catch (error) {
      logger.error('Failed to check deleted post status:', error);
      return false;
    }
  }

  /**
   * Record a post as deleted in the database
   *
   * IMPORTANT: Only call this when you have explicit confirmation that a post
   * is deleted (e.g., 404 response), NOT for transient errors like network issues,
   * timeouts, or 502 errors. Incorrectly marking posts as deleted will permanently
   * block processing of legitimate mentions.
   */
  async markPostAsDeleted(postUri: string, mentionId?: string): Promise<void> {
    try {
      // Extract author_id and post_id from the URI
      // URI format: pubky://[author_pubkey]/pub/pubky.app/posts/[post_id]
      const parts = postUri.split('/');
      const authorId = parts[2]; // The pubkey after pubky://
      const postId = parts[parts.length - 1]; // The last part is the post ID

      await db.query(
        `INSERT INTO deleted_posts (post_uri, mention_id, author_id, post_id, retry_count)
         VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT (post_uri) DO UPDATE
         SET retry_count = deleted_posts.retry_count + 1,
             last_retry_at = now()`,
        [postUri, mentionId || null, authorId, postId]
      );

      logger.info('Marked post as deleted', { postUri, mentionId });
    } catch (error) {
      logger.error('Failed to mark post as deleted:', error);
    }
  }

  /**
   * Fetch a single post with caching and deleted post tracking
   */
  private async fetchPost(postUri: string, mentionId?: string): Promise<Post | null> {
    // Check cache
    if (this.cache.has(postUri)) {
      return this.cache.get(postUri)!;
    }

    // Check if already visited (prevent cycles)
    if (this.visited.has(postUri)) {
      return null;
    }

    // Check if post is already known to be deleted
    if (await this.isPostDeleted(postUri)) {
      logger.debug('Post already marked as deleted, skipping fetch', { postUri });
      // Just return null for known deleted posts - no need to throw errors
      return null;
    }

    this.visited.add(postUri);

    try {
      const post = await this.pubkyService.getPost(postUri);
      if (post) {
        this.cache.set(postUri, post);
        return post;
      }

      // Post returned null - could be a transient error, but NOT a 404
      // (404s throw POST_DELETED error which is caught below)
      logger.debug(`Post not available: ${postUri} (temporary error, not 404)`);
      return null;
    } catch (error: any) {
      // Check if this is a confirmed deletion (404 error)
      if (error?.code === 'POST_DELETED') {
        logger.info(`Post confirmed deleted (404): ${postUri}`);
        // Mark post as deleted in database to avoid future fetch attempts
        await this.markPostAsDeleted(postUri, mentionId);
        // Re-throw the error so it propagates to workers
        throw error;
      }

      // Other unexpected errors - don't mark as deleted
      logger.error(`Unexpected error fetching post ${postUri}:`, error);
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

      let parent: Post | null = null;
      try {
        parent = await this.fetchPost(currentPost.parentUri);
      } catch (error: any) {
        // If parent is deleted (404), just stop fetching parents
        if (error?.code === 'POST_DELETED') {
          logger.info(`Parent post deleted (404), truncating thread at depth ${depth}`);
          break;
        }
        // For other errors, log and stop fetching
        logger.warn(`Failed to fetch parent at depth ${depth}, truncating thread`, error);
        break;
      }
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

    // Check token count - use configured warning threshold
    if (context.totalTokens > appConfig.limits.thread.tokenWarningThreshold) {
      warnings.push(`Thread exceeds recommended token limit (${appConfig.limits.thread.tokenWarningThreshold})`);
      recommendations.push('Consider summarizing earlier posts or using chunking');
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

  /**
   * Resolve participant public keys and format them as mentions
   * Creates participant objects with pk:<pubkey> format for Pubky app mentions
   */
  private async resolveParticipantProfiles(publicKeys: string[]): Promise<ThreadParticipant[]> {
    logger.debug(`Formatting ${publicKeys.length} participant mentions`);

    // Create participant objects with pk:<pubkey> format for mentions
    const participants: ThreadParticipant[] = publicKeys.map(publicKey => {
      // Clean the public key if it has prefixes
      const cleanKey = publicKey
        .replace(/^pk:/, '')
        .replace(/^pubky:\/\//, '')
        .split('/')[0];

      // Format as pk:<pubkey> for proper mentions in Pubky app
      const displayName = `pk:${cleanKey}`;

      return {
        publicKey: cleanKey,
        username: undefined, // Not needed for mentions
        displayName
      };
    });

    return participants;
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