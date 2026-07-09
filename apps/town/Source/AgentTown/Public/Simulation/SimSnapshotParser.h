#pragma once

#include "CoreMinimal.h"
#include "Simulation/SimTypes.h"

/** Parse simulation REST JSON bodies (minimal fields for Phase 0–1). */
class AGENTTOWN_API FSimSnapshotParser
{
public:
	static bool ParseTickSnapshot(const TSharedPtr<FJsonObject>& Root, FSimTickSnapshot& OutSnapshot);
	static bool ParseAgentState(const TSharedPtr<FJsonObject>& AgentObj, FSimAgentState& OutAgent);
	static bool ParseCreateRunResponse(const FString& JsonText, FSimCreateRunResult& OutResult);
	static bool ParseAdvanceTickResponse(const FString& JsonText, FSimAdvanceTickResult& OutResult);
	static bool ParseTickFrameResponse(const FString& JsonText, FSimTickFrameResult& OutResult);
	static bool ParseManifestResponse(const FString& JsonText, FSimManifestResult& OutResult);
	static bool ParseSseEventJson(const FString& JsonText, FSimSseEvent& OutEvent);

private:
	static bool ParseVec3(const TSharedPtr<FJsonObject>& VecObj, FWireVec3& OutVec);
};
