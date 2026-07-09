#pragma once

#include "CoreMinimal.h"

/**
 * Wire world coordinates (Three.js-style: Y-up, right-handed, +X east, +Z south)
 * to Unreal world space (Z-up, left-handed).
 *
 * Single transform point for ApplySnapshot — see docs/06-规划/AgentTown客户端规格.md §6.2.
 */
struct AGENTTOWN_API FWireVec3
{
	double X = 0.0;
	double Y = 0.0;
	double Z = 0.0;

	FWireVec3() = default;
	FWireVec3(double InX, double InY, double InZ) : X(InX), Y(InY), Z(InZ) {}

	bool IsFinite() const;
};

class AGENTTOWN_API FWireCoordinateTransform
{
public:
	/** 1 wire unit = 1 meter = 100 UE centimeters (positions only; NPC capsule/speed stay human-scale). */
	static constexpr double WorldScale = 100.0;

	/** ue = (wire.x, -wire.z, wire.y) * WorldScale */
	static FVector ToUnreal(const FWireVec3& Wire);
	static FVector ToUnreal(double WireX, double WireY, double WireZ);
};
