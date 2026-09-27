# @deepagent-code/slack

Slack bot integration for deepagent-code that creates threaded conversations.

## Setup

1. Create a Slack app at https://api.slack.com/apps
2. Enable Socket Mode
3. Add the following OAuth scopes:
   - `chat:write`
   - `app_mentions:read`
   - `channels:history`
   - `groups:history`
4. Install the app to your workspace
5. Set environment variables in `.env`:
   - `SLACK_BOT_TOKEN` - Bot User OAuth Token
   - `SLACK_SIGNING_SECRET` - Signing Secret from Basic Information
   - `SLACK_APP_TOKEN` - App-Level Token from Basic Information
   - `SLACK_IM_BINDINGS` - optional JSON array binding an existing IM group to a Slack channel, for example `[{"workspaceID":"wrk_team","groupID":"img_team","channelID":"C123","agent":"build"}]`

For each binding, the bot stores the Slack channel in that workspace's external-channel config and
creates thread sessions with `metadata.im.{groupID,agent}`. A policy-approved `im_send` to the group
then writes the durable IM message and posts its scrubbed text to Slack. Create the IM group and
add the agent before starting the bot. Without a binding, Slack threads retain their conversational
behavior and `im_send` requires an explicit `group_id`.

## Usage

```bash
# Edit .env with your Slack app credentials
bun dev
```

The bot will respond to messages in channels where it's added, creating separate deepagent-code sessions for each thread.
