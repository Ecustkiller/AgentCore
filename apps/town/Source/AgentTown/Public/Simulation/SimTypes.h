#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Simulation/WireCoordinateTransform.h"

/** Minimal wire types aligned with agentcore.simulation.types (Phase 0–1). */

struct AGENTTOWN_API FSimAgentState
{
	FString AgentId;
	FString Name;
	FString Role;
	FString Location;
	FWireVec3 Position;
};

struct AGENTTOWN_API FSimTickSnapshot
{
	int32 Tick = 0;
	int32 Hour = 0;
	TMap<FString, FSimAgentState> Agents;
};

struct AGENTTOWN_API FSimBigFive
{
	float Openness = 0.5f;
	float Conscientiousness = 0.5f;
	float Extraversion = 0.5f;
	float Agreeableness = 0.5f;
	float Neuroticism = 0.5f;
};

struct AGENTTOWN_API FSimPersona
{
	FString AgentId;
	FString Name;
	FString Role;
	FString Location;
	FString Goal;
	FSimBigFive BigFive;
};

struct AGENTTOWN_API FSimRunManifest
{
	FString ManifestVersion;
	FString Scenario;
	int32 Seed = 0;
	TArray<FSimPersona> Personas;
	TArray<FString> Regions;
};

struct AGENTTOWN_API FSimManifestResult
{
	FString RunId;
	FSimRunManifest Manifest;
};

struct AGENTTOWN_API FSimDecision
{
	int32 Tick = 0;
	FString AgentId;
	FString Summary;
	FString ActionType;
	FString Location;
};

struct AGENTTOWN_API FSimSseEvent
{
	FString Type;
	TSharedPtr<FJsonObject> Payload;
	FString Timestamp;
};

struct AGENTTOWN_API FSimCreateRunResult
{
	FString Id;
	FString Scenario;
	int32 Seed = 0;
	FString Status;
	int32 CurrentTick = 0;
};

struct AGENTTOWN_API FSimAdvanceTickResult
{
	FString RunId;
	int32 Tick = 0;
};

struct AGENTTOWN_API FSimTickFrameResult
{
	FString RunId;
	int32 TickNumber = 0;
	FSimTickSnapshot Snapshot;
};
