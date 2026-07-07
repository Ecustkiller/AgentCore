#pragma once

#include "CoreMinimal.h"
#include "Simulation/WireCoordinateTransform.h"

/** Client-side session state — single source of truth for UI + 3D (UE-01). */
class AGENTTOWN_API FSimulationSession
{
public:
	static FSimulationSession& Get();

	void Reset();

	void ApplySnapshot(const TMap<FString, FWireVec3>& AgentWirePositions);

	int32 GetTick() const { return Tick; }
	bool IsLive() const { return Mode == ESimulationClientMode::Live; }

private:
	enum class ESimulationClientMode : uint8
	{
		Live,
		Replay,
	};

	ESimulationClientMode Mode = ESimulationClientMode::Live;
	int32 Tick = 0;

	TMap<FString, FVector> AgentUnrealPositions;
};
