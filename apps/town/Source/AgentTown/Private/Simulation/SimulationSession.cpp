#include "Simulation/SimulationSession.h"

FSimulationSession& FSimulationSession::Get()
{
	static FSimulationSession Instance;
	return Instance;
}

void FSimulationSession::Reset()
{
	Mode = ESimulationClientMode::Live;
	Tick = 0;
	AgentUnrealPositions.Reset();
}

void FSimulationSession::ApplySnapshot(const TMap<FString, FWireVec3>& AgentWirePositions)
{
	AgentUnrealPositions.Reset();
	for (const TPair<FString, FWireVec3>& Pair : AgentWirePositions)
	{
		AgentUnrealPositions.Add(Pair.Key, FWireCoordinateTransform::ToUnreal(Pair.Value));
	}
}
