#pragma once

#include "CoreMinimal.h"
#include "AIController.h"
#include "TownNpcAIController.generated.h"

/** NavMesh-driven movement for live simulation snapshots. */
UCLASS()
class AGENTTOWN_API ATownNpcAIController : public AAIController
{
	GENERATED_BODY()

public:
	ATownNpcAIController();

	void SetNavigationGoal(const FVector& WorldLocation);
	void TeleportToGoal(const FVector& WorldLocation);
	bool HasReachedGoal(float Tolerance = 100.0f) const;

	const FVector& GetNavigationGoal() const { return NavigationGoal; }
	bool HasActiveGoal() const { return bHasGoal; }

private:
	FVector NavigationGoal = FVector::ZeroVector;
	bool bHasGoal = false;
};
