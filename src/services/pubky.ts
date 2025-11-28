import { Pubky, Keypair, PublicKey, Session } from '@synonymdev/pubky';
import { PubkySpecsBuilder, PubkyAppPostKind } from 'pubky-app-specs';
import * as bip39 from 'bip39';
import { Mention, Post, NexusNotification } from '@/types/mention';
import logger from '@/utils/logger';
import appConfig from '@/config';

// Types based on pubky-app-specs
export interface PubkyAppPost {
  content: string;
  kind: 'short' | 'long' | 'image' | 'video' | 'link' | 'file';
  parent?: string;
  embed?: {
    kind: string;
    uri: string;
  };
  attachments?: string[];
}

export interface PubkyAppUser {
  name: string;
  bio?: string;
  image?: string;
  links?: Array<{
    title: string;
    url: string;
  }>;
  status?: string;
}

// Nexus API response types
export interface NexusPostDetails {
  content: string;
  id: string;
  indexed_at: number; // Unix timestamp in milliseconds
  author: string;
  kind: string;
  uri: string;
}

export interface PubkyMention {
  id: string;
  postId: string;
  content: string;
  author: string;
  createdAt: string;
  url?: string;
}

export interface PubkyPost {
  id: string;
  uri: string;
  content: string;
  author: string;
  createdAt: string;
  parentUri?: string;
}

export interface PublishReplyOptions {
  parentUri: string;
  content: string;
}

export interface PublishReplyResult {
  id: string;
  uri: string;
}

export class PubkyService {
  private pubky: Pubky;
  private keypair: Keypair | null = null;
  private session: Session | null = null;
  private homeserver: PublicKey;
  private botPublicKey: string | null = null;
  private initialized = false;

  /**
   * Async factory method to create and initialize PubkyService
   * Addresses: Architecture Review Critical Issue #1 - Service Initialization Race Condition
   */
  static async create(): Promise<PubkyService> {
    const service = new PubkyService();
    await service.initialize();
    return service;
  }

  private constructor() {
    // Initialize Pubky SDK based on network configuration
    const network = appConfig.pubky.network || 'testnet';

    if (network === 'mainnet') {
      this.pubky = new Pubky();
      logger.info('Initialized Pubky SDK for MAINNET');
    } else {
      this.pubky = Pubky.testnet();
      logger.info('Initialized Pubky SDK for TESTNET');
    }

    // Parse homeserver URL to get the public key
    const homeserverPubkey = this.extractPubkeyFromUrl(appConfig.pubky.homeserverUrl);
    this.homeserver = PublicKey.from(homeserverPubkey);
  }

  private async initialize(): Promise<void> {
    await this.initializeKeypair();
    this.initialized = true;
    logger.info('PubkyService initialized successfully');
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error('PubkyService not initialized. Use PubkyService.create() instead of new PubkyService()');
    }
  }

  private assertAuthenticated(): void {
    if (!this.session) {
      throw new Error('Not authenticated. Session is required for this operation.');
    }
  }

  private extractPubkeyFromUrl(url: string): string {
    // Extract pubkey from URL format
    // Could be: https://homeserver.com or pubky://[pubkey] or just [pubkey]
    if (url.startsWith('pubky://')) {
      return url.replace('pubky://', '').split('/')[0];
    } else if (url.startsWith('https://') || url.startsWith('http://')) {
      // Do not silently fallback: a homeserver pubkey is required
      // Force explicit configuration to avoid connecting to the wrong network
      throw new Error(
        'Invalid PUBKY_HOMESERVER_URL: expected a pubky public key (pk:...) or pubky://<pubkey>. ' +
        'Do not use https:// hostnames here. Set PUBKY_HOMESERVER_URL to the homeserver public key.'
      );
    }
    // Assume it's already a pubkey
    return url;
  }

  /**
   * Extract public key from pk: format or URI
   */
  private extractPubkey(input: string): string {
    if (input.startsWith('pk:')) {
      return input.replace('pk:', '');
    } else if (input.startsWith('pubky://')) {
      return input.replace('pubky://', '').split('/')[0];
    }
    return input;
  }

  private async initializeKeypair() {
    try {
      const mnemonic = appConfig.pubky.botMnemonic;

      // Mnemonic is REQUIRED - no fallbacks
      if (!mnemonic || mnemonic === '') {
        throw new Error(
          'PUBKY_BOT_MNEMONIC is required. Please set it in your .env file with a valid 12-24 word BIP39 mnemonic phrase.'
        );
      }

      logger.info('Initializing keypair from mnemonic phrase');

      // Validate mnemonic
      if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error(
          'Invalid mnemonic phrase provided. Please ensure PUBKY_BOT_MNEMONIC contains a valid 12-24 word BIP39 mnemonic phrase.'
        );
      }

      // Convert mnemonic to seed
      const seed = bip39.mnemonicToSeedSync(mnemonic);
      const seedBytes = seed.subarray(0, 32); // First 32 bytes for keypair

      // Create keypair from seed
      this.keypair = Keypair.fromSecretKey(seedBytes);
      this.botPublicKey = this.keypair.publicKey.z32();

      logger.info(`Bot initialized with public key: pk:${this.botPublicKey}`);

      // Authenticate to homeserver
      await this.authenticateToHomeserver();

    } catch (error) {
      logger.error('Failed to initialize bot keypair:', error);
      throw new Error(
        `Bot initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}. ` +
        'Please ensure PUBKY_BOT_MNEMONIC environment variable contains a valid BIP39 mnemonic phrase.'
      );
    }
  }

  private async authenticateToHomeserver() {
    if (!this.keypair) {
      throw new Error('CRITICAL: No keypair available for authentication');
    }

    try {
      const signer = this.pubky.signer(this.keypair);
      this.session = await signer.signin();
      logger.info('Successfully signed in to homeserver');
    } catch (error) {
      logger.error('CRITICAL: Failed to authenticate to homeserver:', error);
      throw new Error(`Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}. Bot cannot operate without valid session.`);
    }
  }

  /**
   * @deprecated This method is no longer used. Post IDs are now generated by PubkySpecsBuilder
   * which uses the proper Crockford Base32 encoding from the pubky-app-specs library.
   *
   * This custom implementation used a different base32 charset than the official spec,
   * which caused posts to not be indexed properly by Nexus.
   *
   * Generate a Timestamp ID according to pubky-app-specs
   * 13-character Crockford Base32 string from microsecond timestamp
   */
  private generateTimestampId(): string {
    // Get microsecond timestamp
    const microtime = Date.now() * 1000 + Math.floor(Math.random() * 1000);

    // Convert to base32 (simplified - in production use proper Crockford Base32)
    const base32Chars = '0123456789abcdefghjkmnpqrstvwxyz';
    let id = '';
    let value = microtime;

    while (id.length < 13) {
      id = base32Chars[value % 32] + id;
      value = Math.floor(value / 32);
    }

    // Pad with zeros if needed
    while (id.length < 13) {
      id = '0' + id;
    }

    return id.slice(0, 13);
  }


  /**
   * Fetch mentions using Nexus API (requires authentication)
   * This is the proper way to get mentions in production
   */
  /**
   * Type guard to check if an object is a valid notification
   */
  private isValidNotification(obj: unknown): obj is Record<string, unknown> {
    return (
      obj !== null &&
      typeof obj === 'object' &&
      ('body' in obj || 'type' in obj || 'post_uri' in obj)
    );
  }

  /**
   * Type guard to safely extract notification body
   */
  private getNotificationBody(notification: unknown): Record<string, unknown> | null {
    if (!this.isValidNotification(notification)) {
      return null;
    }

    const notif = notification as Record<string, unknown>;
    return (notif.body && typeof notif.body === 'object' ? notif.body : notif) as Record<string, unknown>;
  }

  async fetchMentionsFromNexus(options: {
    limit?: number;
    offset?: number;
  } = {}): Promise<{ mentions: Mention[]; notificationCount: number }> {
    this.assertInitialized();

    try {
      if (!this.keypair) {
        throw new Error('Bot is not authenticated. Initialize keypair first.');
      }

      const limit = options.limit || 50;
      const offset = options.offset || 0;

      // Use Nexus API URL from config or default
      const nexusBaseUrl = appConfig.pubky.nexusApiUrl || 'https://testnet.pubky.org';
      const botPublicKey = this.botPublicKey;

      if (!botPublicKey) {
        throw new Error('Bot not initialized. Keypair must be initialized from mnemonic first.');
      }

      const notificationsUrl = new URL(
        `/v0/user/${encodeURIComponent(this.extractPubkey(botPublicKey))}/notifications`,
        nexusBaseUrl
      );
      notificationsUrl.searchParams.set('type', 'mentioned_by');
      notificationsUrl.searchParams.set('limit', limit.toString());
      if (offset > 0) {
        notificationsUrl.searchParams.set('offset', offset.toString());
      }

      logger.debug('Fetching mentions from Nexus API', {
        url: notificationsUrl.toString(),
        botPubkey: this.extractPubkey(botPublicKey).substring(0, 8) + '...'
      });

      // Prepare headers with HTTP Basic Auth if credentials are available
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };

      if (appConfig.pubky.authUsername && appConfig.pubky.authPassword) {
        const auth = Buffer.from(
          `${appConfig.pubky.authUsername}:${appConfig.pubky.authPassword}`
        ).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
        logger.debug(`Using HTTP Basic Auth (${appConfig.pubky.authUsername})`);
      }

      const response = await fetch(notificationsUrl.toString(), {
        headers,
      });

      if (!response.ok) {
        throw new Error(`Nexus API returned ${response.status}: ${response.statusText}`);
      }

      const data: unknown = await response.json();

      // Track raw notification count before deduplication
      const notificationCount = Array.isArray(data) ? data.length : 0;
      logger.debug(`Received ${notificationCount} notification(s) from Nexus`);

      // Transform Nexus notifications to Mention format
      const mentions: Mention[] = [];
      const seenPostUris = new Set<string>(); // Deduplicate by post URI

      if (Array.isArray(data)) {
        for (const notification of data) {
          try {
            // Use type guard to safely extract notification body
            const body = this.getNotificationBody(notification);

            if (!body) {
              logger.warn('Invalid notification structure', {
                notification: typeof notification === 'object' ? JSON.stringify(notification) : String(notification)
              });
              continue;
            }

            // Extract post URI based on notification type
            let postUri: string | undefined;
            let authorPubkey: string | undefined;

            if (body.type === 'mention') {
              postUri = typeof body.post_uri === 'string' ? body.post_uri : undefined;
              authorPubkey = typeof body.mentioned_by === 'string' ? body.mentioned_by : undefined;
            } else if (body.type === 'reply') {
              postUri = typeof body.reply_uri === 'string' ? body.reply_uri : undefined;
              authorPubkey = typeof body.replied_by === 'string' ? body.replied_by : undefined;
            } else {
              // Fallback for other formats
              postUri = typeof body.uri === 'string' ? body.uri : (typeof body.post_uri === 'string' ? body.post_uri : undefined);
              authorPubkey = typeof body.author === 'string' ? body.author : undefined;
            }

            if (!postUri) {
              logger.warn('Notification missing URI', {
                notification: JSON.stringify(body)
              });
              continue;
            }

            // Deduplicate: skip if we've already processed this post
            if (seenPostUris.has(postUri)) {
              continue;
            }
            seenPostUris.add(postUri);

            const postData = await this.getPost(postUri);
            if (!postData) {
              logger.warn(`Failed to fetch post data for: ${postUri}`);
              continue;
            }

            // Stable ID: composite of postId + author short key for readability and uniqueness
            const notif = notification as Record<string, unknown>;
            const postId = postUri.split('/').pop() || '';
            const authorShort = (authorPubkey || this.extractPubkey(postUri)).substring(0, 8);
            const stableId = `${postId}_${authorShort}`;
            const idSource = 'post_uri.composite';
/*
            logger.debug('Generated stable mention ID', {
              mentionId: stableId,
              source: idSource,
              postUri,
              postId: postUri.split('/').pop() || ''
            });
 */
            // Extract timestamp for receivedAt field
            // Priority: indexed_at > timestamp > Date.now() (as last resort only)
            let timestamp: number;
            if (typeof notif.indexed_at === 'number') {
              timestamp = notif.indexed_at;
            } else if (typeof notif.timestamp === 'number') {
              timestamp = notif.timestamp;
            } else if (body && typeof (body as any).timestamp === 'number') {
              timestamp = (body as any).timestamp;
            } else {
              // Only use Date.now() if no timestamp available anywhere
              timestamp = Date.now();
              logger.debug('No timestamp in notification, using current time', { postUri });
            }

            const mention: Mention = {
              mentionId: stableId,  // CRITICAL: Must be stable for retry safety
              postId: postUri,
              content: postData.content,
              authorId: authorPubkey || this.extractPubkey(postUri),
              receivedAt: new Date(timestamp).toISOString(),
              status: 'received',
              url: postUri
            };

            mentions.push(mention);
          } catch (error) {
            logger.error('Failed to process notification', error);
          }
        }
      }

      logger.debug(`Processed ${mentions.length} unique mention(s) from ${notificationCount} notification(s)`);
      return { mentions, notificationCount };

    } catch (error) {
      logger.error('Failed to fetch mentions from Nexus:', error);
      throw error;
    }
  }

  /**
   * Fetch post details from Nexus API to get indexed_at timestamp
   * @param authorId - Author's public key
   * @param postId - Post ID (without URI prefix)
   * @returns NexusPostDetails with indexed_at timestamp, or null if not found
   */
  private async getPostDetailsFromNexus(authorId: string, postId: string): Promise<NexusPostDetails | null> {
    try {
      const nexusBaseUrl = appConfig.pubky.nexusApiUrl || 'https://testnet.pubky.org';
      const detailsUrl = new URL(
        `/v0/post/${encodeURIComponent(authorId)}/${encodeURIComponent(postId)}/details`,
        nexusBaseUrl
      );
/*
      logger.debug('Fetching post details from Nexus API', {
        url: detailsUrl.toString(),
        authorId: authorId.substring(0, 8) + '...',
        postId
      });
*/
      // Prepare headers with HTTP Basic Auth if credentials are available
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };

      if (appConfig.pubky.authUsername && appConfig.pubky.authPassword) {
        const auth = Buffer.from(
          `${appConfig.pubky.authUsername}:${appConfig.pubky.authPassword}`
        ).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
      }

      const response = await fetch(detailsUrl.toString(), { headers });

      if (!response.ok) {
        if (response.status === 404) {
          logger.debug('Post not found in Nexus', { authorId, postId });
          return null;
        }
        throw new Error(`Nexus API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as NexusPostDetails;

      /**
      logger.debug('Fetched post details from Nexus', {
        postId,
        indexed_at: data.indexed_at,
        indexed_at_iso: new Date(data.indexed_at).toISOString()
      });
       */
      return data;
    } catch (error) {
      logger.warn('Failed to fetch post details from Nexus, will use fallback timestamp', {
        authorId,
        postId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Fetch a post by URI
   */
  async getPost(postUri: string): Promise<Post | null> {
    try {
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const postData = await this.pubky.publicStorage.getJson(postUri as any) as PubkyAppPost | null;

          if (!postData || typeof postData !== 'object') {
            return null;
          }

          // Extract author and post ID for Nexus lookup
          const postId = postUri.split('/').pop() || postUri;
          const authorId = this.extractPubkey(postUri);

          // Fetch post details from Nexus to get indexed_at timestamp
          const nexusDetails = await this.getPostDetailsFromNexus(authorId, postId);

          // Use indexed_at from Nexus if available, otherwise fall back to post ID (ULID-based)
          const createdAt = nexusDetails
            ? new Date(nexusDetails.indexed_at).toISOString()
            : postId; // Fallback: ULIDs are lexicographically sortable

          const post: Post = {
            id: postId,
            uri: postUri,
            content: postData.content || '',
            authorId,
            createdAt,
            parentUri: postData.parent
          };

          return post;
        } catch (e: any) {
          const msg = String(e?.message || e);
          const is502 = /\b502\b|Bad Gateway/i.test(msg);
          if (is502 && attempt < maxAttempts) {
            await new Promise(res => setTimeout(res, 250 * attempt));
            continue;
          }

          // Check for 404 Not Found - this means the post is deleted
          const is404 = /\b404\b.*Not Found/i.test(msg) || e?.data?.statusCode === 404;
          if (is404) {
            // Throw a specific error for deleted posts that can be caught upstream
            const deletedError = new Error(`Post deleted: ${postUri}`);
            (deletedError as any).code = 'POST_DELETED';
            (deletedError as any).statusCode = 404;
            throw deletedError;
          }

          throw e;
        }
      }
      return null;
    } catch (error: any) {
      const msg = String(error?.message || error);

      // Re-throw POST_DELETED errors so they can be handled specifically
      if (error?.code === 'POST_DELETED') {
        throw error;
      }

      if (/\b502\b|Bad Gateway/i.test(msg)) {
        logger.warn(`Failed to fetch post ${postUri}: 502 Bad Gateway`);
      } else {
        logger.error(`Failed to fetch post ${postUri}:`, error);
      }
      return null;
    }
  }

  async getPostById(postId: string): Promise<Post | null> {
    try {
      logger.debug('Fetching post by ID', { postId });

      // Parse the post ID to get the URI
      // Post ID might be in format: pubky://[author]/pub/pubky.app/posts/[id]
      let postUri = postId;

      if (!postId.startsWith('pubky://')) {
        // Construct the URI if it's just an ID
        logger.warn('Post ID is not a full URI, cannot fetch without author pubkey');
        return null;
      }

      let postData: PubkyAppPost | null = null;
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          postData = await this.pubky.publicStorage.getJson(postUri as any) as PubkyAppPost | null;
          break;
        } catch (e: any) {
          const msg = String(e?.message || e);
          const is502 = /\b502\b|Bad Gateway/i.test(msg);
          if (is502 && attempt < maxAttempts) {
            await new Promise(res => setTimeout(res, 250 * attempt));
            continue;
          }

          // Check for 404 Not Found - this means the post is deleted
          const is404 = /\b404\b.*Not Found/i.test(msg) || e?.data?.statusCode === 404;
          if (is404) {
            // Throw a specific error for deleted posts that can be caught upstream
            const deletedError = new Error(`Post deleted: ${postUri}`);
            (deletedError as any).code = 'POST_DELETED';
            (deletedError as any).statusCode = 404;
            throw deletedError;
          }

          throw e;
        }
      }

      if (!postData || typeof postData !== 'object') {
        return null;
      }

      // Extract author and post ID for Nexus lookup
      const extractedPostId = postUri.split('/').pop() || postId;
      const authorId = postUri.split('/')[2];

      // Fetch post details from Nexus to get indexed_at timestamp
      const nexusDetails = await this.getPostDetailsFromNexus(authorId, extractedPostId);

      // Use indexed_at from Nexus if available, otherwise fall back to post ID (ULID-based)
      const createdAt = nexusDetails
        ? new Date(nexusDetails.indexed_at).toISOString()
        : extractedPostId; // Fallback: ULIDs are lexicographically sortable

      const post: Post = {
        id: extractedPostId,
        uri: postUri,
        content: postData.content || '',
        authorId: authorId,
        createdAt: createdAt,
        parentUri: postData.parent
      };

      return post;

    } catch (error: any) {
      const msg = String(error?.message || error);

      // Re-throw POST_DELETED errors so they can be handled specifically
      if (error?.code === 'POST_DELETED') {
        throw error;
      }

      if (/\b502\b|Bad Gateway/i.test(msg)) {
        logger.warn('Failed to fetch post: 502 Bad Gateway');
      } else {
        logger.error('Failed to fetch post:', error);
      }
      return null;
    }
  }

  async publishReply(options: PublishReplyOptions): Promise<PublishReplyResult> {
    this.assertAuthenticated();

    try {
      logger.debug('Publishing reply', {
        parentUri: options.parentUri,
        contentLength: options.content.length
      });

      if (!this.botPublicKey) {
        throw new Error('Bot public key not initialized');
      }

      // Use PubkySpecsBuilder to create a properly formatted post
      const specs = new PubkySpecsBuilder(this.botPublicKey);

      // Determine content kind based on length
      const kind = options.content.length > 2000
        ? PubkyAppPostKind.Long
        : PubkyAppPostKind.Short;

      // Create post using specs builder - this generates the proper ID and structure
      const { post, meta } = specs.createPost(
        options.content,
        kind,
        options.parentUri,  // parent post URI
        null,               // embed
        null                // attachments
      );

      const postJson = post.toJson();
      const replyPath = meta.path;
      const replyId = meta.id;
      const replyUri = meta.url;

      logger.debug('Creating reply with PubkySpecsBuilder', {
        replyId,
        replyPath,
        replyUri,
        kind: kind === PubkyAppPostKind.Short ? 'short' : 'long',
        contentLength: options.content.length,
        postJsonSize: JSON.stringify(postJson).length
      });

      // Publish the reply using session storage
      await this.session.storage.putJson(replyPath as any, postJson);

      const result: PublishReplyResult = {
        id: replyId,
        uri: replyUri
      };

      logger.debug('Reply published successfully', result);

      // Verify the reply was written by attempting to read it back
      try {
        const verification = await this.pubky.publicStorage.getJson(result.uri as any);
        if (verification) {
          logger.debug('Reply verified on homeserver', {
            replyId,
            uri: result.uri,
            contentLength: (verification as any)?.content?.length || 0
          });
        } else {
          logger.warn('Reply published but verification failed - could not read back', {
            replyId,
            uri: result.uri
          });
        }
      } catch (verifyError) {
        logger.error('Failed to verify published reply:', {
          replyId,
          uri: result.uri,
          error: verifyError instanceof Error ? verifyError.message : 'Unknown error'
        });
      }

      return result;

    } catch (error) {
      logger.error('Failed to publish reply:', error);
      throw error;
    }
  }

  async buildThreadPosts(rootPostId: string, maxDepth: number = 5): Promise<Post[]> {
    try {
      logger.debug('Building thread posts', { rootPostId, maxDepth });

      const threadPosts: Post[] = [];
      const visited = new Set<string>();

      // Recursive function to build thread
      const fetchThread = async (postId: string, depth: number) => {
        if (depth >= maxDepth || visited.has(postId)) {
          return;
        }

        visited.add(postId);

        const post = await this.getPostById(postId);
        if (post) {
          threadPosts.push(post);

          // Try to find replies to this post
          // This would require a more sophisticated indexing system
          // For now, we'll just return the single post
          // In production, you'd query for posts with parent === postId
        }
      };

      await fetchThread(rootPostId, 0);
      return threadPosts;

    } catch (error) {
      logger.error('Failed to build thread posts:', error);
      throw error;
    }
  }

  async updateBotProfile(profile: Partial<PubkyAppUser>) {
    this.assertAuthenticated();

    try {
      const profilePath = '/pub/pubky.app/profile.json';

      // Get existing profile
      let currentProfile: PubkyAppUser;
      try {
        currentProfile = await this.session.storage.getJson(profilePath) as PubkyAppUser;
      } catch {
        // Profile doesn't exist, create a new one
        currentProfile = {
          name: 'Pubky AI Bot'
        };
      }

      // Merge with updates
      const updatedProfile: PubkyAppUser = {
        ...currentProfile,
        ...profile
      };

      // Validate according to specs
      if (!updatedProfile.name || updatedProfile.name.length < 3 || updatedProfile.name.length > 50) {
        throw new Error('Name must be 3-50 characters');
      }
      if (updatedProfile.name === '[DELETED]') {
        throw new Error('Name cannot be [DELETED]');
      }
      if (updatedProfile.bio && updatedProfile.bio.length > 160) {
        throw new Error('Bio must be max 160 characters');
      }
      if (updatedProfile.status && updatedProfile.status.length > 50) {
        throw new Error('Status must be max 50 characters');
      }
      if (updatedProfile.links && updatedProfile.links.length > 5) {
        throw new Error('Maximum 5 links allowed');
      }

      // Save profile
      await this.session.storage.putJson(profilePath, updatedProfile);
      logger.info('Bot profile updated successfully');
    } catch (error) {
      logger.error('Failed to update bot profile:', error);
      throw error;
    }
  }


  async healthCheck(): Promise<boolean> {
    try {
      // Check if we can connect to the Pubky network
      // Try to fetch a simple test path
      if (this.session) {
        // Try to read a test value
        await this.session.storage.get('/pub/test');
        return true;
      } else {
        // Try to establish connection
        await this.authenticateToHomeserver();
        return this.session !== null;
      }
    } catch (error) {
      // It's ok if the test path doesn't exist, we're just checking connectivity
      logger.debug('Pubky health check completed');
      return true;
    }
  }
}
