#include "Town/TownNpcAIController.h"
#include "Navigation/PathFollowingComponent.h"

ATownNpcAIController::ATownNpcAIController()
{
	bWantsPlayerState = false;
}

void ATownNpcAIController::SetNavigationGoal(const FVector& WorldLocation)
{
	NavigationGoal = WorldLocation;
	bHasGoal = true;

	if (APawn* ControlledPawn = GetPawn())
	{
		const float AcceptanceRadius = 80.0f;
		MoveToLocation(WorldLocation, AcceptanceRadius, true, true, false, true);
	}
}

void ATownNpcAIController::TeleportToGoal(const FVector& WorldLocation)
{
	NavigationGoal = WorldLocation;
	bHasGoal = true;
	StopMovement();

	if (APawn* ControlledPawn = GetPawn())
	{
		ControlledPawn->SetActorLocation(WorldLocation);
	}
}

bool ATownNpcAIController::HasReachedGoal(const float Tolerance) const
{
	if (!bHasGoal)
	{
		return true;
	}

	const APawn* ControlledPawn = GetPawn();
	if (!ControlledPawn)
	{
		return false;
	}

	return FVector::Dist2D(ControlledPawn->GetActorLocation(), NavigationGoal) <= Tolerance;
}
