# use-live-credentials.ps1 — put the Agent Core project credential into THIS shell session only.
#
# Why this exists
#   This repo's adapter reads its configuration from environment variables
#   (AGENT_CORE_URL / AGENT_CORE_PROJECT / AGENT_CORE_PROJECT_TOKEN, or the AGENT_PLATFORM_* names).
#   The real credential is NOT in this repo and must never be: it lives in a per-user DPAPI store
#   (%LOCALAPPDATA%\agent-core\secrets.clixml) managed by the agent-core custody tooling.
#   This script bridges the two without writing or printing the secret.
#
# What it does NOT do
#   * It never prints, echoes, or logs any secret value — only booleans and the source name.
#   * It writes NO file, commits nothing, and changes nothing outside the current process tree.
#   * It sets process-scoped environment variables, so they disappear when the shell closes.
#
# Usage (dot-source it, do not run it as a child process, or the variables vanish with the child):
#   . .\agent\scripts\use-live-credentials.ps1
#   node agent\cli.js doctor
#   node agent\cli.js decide --use-case pr_risk_review --summary "synthetic check"
#
# Fail-closed: if the custody module or the store is missing, it sets nothing and exits non-zero.

[CmdletBinding()]
param(
  # Folder holding the agent-core custody tooling (bin/AgentCore.psm1). Override with AGENT_CORE_CUSTODY_DIR.
  [string]$CustodyDir = $env:AGENT_CORE_CUSTODY_DIR,
  # Gateway base URL. Must match the identity issued on the platform.
  [string]$BaseUrl = 'https://agent.raemanagemju.net',
  [string]$Project = 'rae-attendance-v2'
)

$ErrorActionPreference = 'Stop'

if (-not $CustodyDir) {
  # Sibling layout used on this workstation. Not an assumption about other machines.
  #   $PSScriptRoot            = <repo>\agent\scripts
  #   parent                   = <repo>\agent
  #   parent                   = <repo>
  #   parent                   = G:\ProjectAI
  $repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  $projectAiRoot = Split-Path $repoRoot -Parent
  $CustodyDir = Join-Path $projectAiRoot 'agent-core-local'
}

$modulePath = Join-Path $CustodyDir 'bin\AgentCore.psm1'
if (-not (Test-Path $modulePath)) {
  Write-Error "custody module not found at '$modulePath'. Set AGENT_CORE_CUSTODY_DIR to the folder that contains bin\AgentCore.psm1."
  exit 1
}

Import-Module $modulePath -Force
$secrets = Get-AgentCoreSecrets

if (-not $secrets.ProjectToken) {
  Write-Error 'no project token available (DPAPI store or AGENTCORE_PROJECT_TOKEN). Nothing was set.'
  exit 1
}

# Process-scoped only. The adapter prefers AGENT_CORE_* over AGENT_PLATFORM_*.
$env:AGENT_CORE_URL = $BaseUrl
$env:AGENT_CORE_PROJECT = $Project
$env:AGENT_CORE_PROJECT_TOKEN = [string]$secrets.ProjectToken

# The public edge also requires a Cloudflare Access service token. Exported for callers that need it;
# the repo adapter itself does not send these headers.
if ($secrets.CfClientId) { $env:AGENT_CORE_CF_CLIENT_ID = [string]$secrets.CfClientId }
if ($secrets.CfClientSecret) { $env:AGENT_CORE_CF_CLIENT_SECRET = [string]$secrets.CfClientSecret }

# Report status WITHOUT any value.
Write-Output 'live credentials loaded for this shell session:'
Write-Output "  AGENT_CORE_URL            = $BaseUrl"
Write-Output "  AGENT_CORE_PROJECT        = $Project"
Write-Output "  AGENT_CORE_PROJECT_TOKEN  = present ($($secrets.Source) source, not printed)"
Write-Output "  cloudflare access pair    = present ($([bool]$secrets.CfClientId))"
Write-Output '  scope: decision only -> POST /v1/decision is the only callable endpoint'
