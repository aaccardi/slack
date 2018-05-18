const logger = require('probot/lib/logger');
const GitHubApi = require('probot/lib/github');

const cache = require('../cache');
const githubUrl = require('../github-url');

class UnsupportedResource extends Error {
  constructor(url) {
    super(url);
    this.name = 'UnsupportedResource';
  }
}

class GitHubAccountNotConnected extends Error {
  constructor() {
    super();
    this.name = 'GitHubAccountNotConnected';
  }
}

/* eslint-disable global-require */
const resources = {
  account: require('../unfurls/account'),
  blob: require('../unfurls/blob'),
  comment: require('../unfurls/comment'),
  issue: require('../unfurls/issue'),
  pull: require('../unfurls/pull'),
  repo: require('../unfurls/repo'),
};

module.exports = (sequelize, DataTypes) => {
  const {
    SlackWorkspace, SlackUser, GitHubUser, Subscription,
  } = sequelize.models;
  const Unfurl = sequelize.define('Unfurl', {
    url: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    channelSlackId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    githubType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    githubRepoId: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    isCondensed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    isPublic: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    isDelivered: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    slackMessageTimestamp: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  });

  Unfurl.associate = (models) => {
    Unfurl.belongsTo(models.SlackWorkspace, {
      foreignKey: 'slackWorkspaceId',
      allowNull: false,
    });
    Unfurl.belongsTo(models.SlackUser, {
      foreignKey: 'slackUserId',
      allowNull: true,
    });
  };


  Object.assign(Unfurl.prototype, {
    async removeUnfurlEligibility() {
      const slackWorkspace = await SlackWorkspace.findById(this.slackWorkspaceId);
      const key = `${slackWorkspace.slackId}-${this.channelSlackId}-${this.url}`;
      return cache.set(key, true);
    },

    async deliver() {
      const slackWorkspace = await SlackWorkspace.findById(this.slackWorkspaceId);
      const github = await this.constructor.getGitHubClient(this.slackUserId);
      const {
        attachment,
        githubType,
      } = await this.constructor.getAttachment(github, this.url, this.isCondensed, this.isPublic);
      const unfurls = {
        [this.url]: attachment,
      };
      logger.debug(unfurls, 'Unfurling links');
      const slackRes = await slackWorkspace.client.chat.unfurl({
        ts: this.slackMessageTimestamp,
        channel: this.channelSlackId,
        unfurls,
      });
      logger.trace(slackRes, 'Unfurl complete');
      await this.removeUnfurlEligibility();
      this.githubType = githubType;
      this.isDelivered = true;
      await this.save();
    },
  });

  Object.assign(Unfurl, {
    async getGitHubClient(slackUserId) {
      const github = new GitHubApi({ logger });

      const slackUser = await SlackUser.findById(slackUserId, {
        include: [GitHubUser],
      });

      if (!slackUser.GitHubUser) {
        if (process.env.GITHUB_TOKEN) {
          github.authenticate({
            type: 'token',
            token: process.env.GITHUB_TOKEN,
          });
          logger.debug({ userSlackId: slackUser.slackId }, 'using PAT authed github client for unfurl');
        }
        return github;
      }
      github.authenticate({
        type: 'oauth',
        token: slackUser.GitHubUser.accessToken,
      });
      logger.debug({
        userSlackId: slackUser.slackId,
        userGitHubId: slackUser.GitHubUser.id,
      }, 'using user authed github client for unfurl');
      return github;
    },

    async isEligibleForUnfurl(teamId, channelId, url) {
      const key = `${teamId}-${channelId}-${url}`;
      const recentlySeen = await cache.get(key);
      return !recentlySeen;
    },

    async getAttachment(github, url, isCondensed, isPublic) {
      const unfurlType = isCondensed ? 'condensed' : 'full';
      const params = githubUrl(url);
      if (!params || !resources[params.type]) {
        throw new UnsupportedResource(url);
      }
      const attachment = await resources[params.type](params, github, unfurlType);

      // Add lock to the footer if resource is not public
      if (!isPublic) {
        attachment.footer = `:lock: ${attachment.footer}`;
      }

      return {
        attachment,
        githubType: params.type,
      };
    },

    async isPrivate(github, url) {
      const params = githubUrl(url);
      if (!params || !resources[params.type]) {
        throw new UnsupportedResource(url);
      }
      // for now: if it's not part of a repo, then it can't be private
      if (!('repo' in params)) {
        return {
          repoIsPrivate: false,
          repoId: undefined,
        };
      }
      let repo;
      try {
        repo = await github.repos.get({ owner: params.owner, repo: params.repo });
      } catch (e) {
        throw new GitHubAccountNotConnected();
      }
      return {
        repoIsPrivate: repo.data.private,
        repoId: repo.data.id,
      };
    },

    async promptOrDeliver({
      teamId, userId, channel, url, isCondensed, slackMessageTimestamp,
    }) {
      const workspace = await SlackWorkspace.findOne({
        where: { slackId: teamId },
      });

      const [slackUser] = await SlackUser.findOrCreate({
        where: {
          slackWorkspaceId: parseInt(workspace.id, 10),
          slackId: userId,
        },
      });

      let isPublic = true;
      // if user does not have github account linked then we attempt PAT-based unfurl
      // if the PAT based unfurl does not work we can prompt them to connect their account
      const github = await this.getGitHubClient(slackUser.id);
      const { repoIsPrivate, repoId } = await this.isPrivate(github, url);
      if (repoIsPrivate) {
        if (
          await Subscription.lookupOne(repoId, channel, workspace.id) ||
          slackUser.allowsAutomaticUnfurl(repoId, channel)
        ) {
          // No need to prompt because unfurl is part of subscribed repo
          // or user allows automatic unfurl
          isPublic = false;
        } else {
          if (slackUser.hasUnfurlPromptsMuted()) {
            return;
          }
          return this.create({
            slackWorkspaceId: workspace.id,
            slackUserId: slackUser.id,
            channelSlackId: channel,
            url,
            isCondensed,
            isPublic: false,
            slackMessageTimestamp,
            isDelivered: false,
            githubRepoId: repoId,
          });
        }
      }

      const unfurl = await this.build({
        slackWorkspaceId: workspace.id,
        slackUserId: slackUser.id,
        channelSlackId: channel,
        url,
        isCondensed,
        isPublic,
        isDelivered: false,
        slackMessageTimestamp,
      });
      // Deliver immediately
      await unfurl.deliver();
      return unfurl;
    },
  });

  return Unfurl;
};