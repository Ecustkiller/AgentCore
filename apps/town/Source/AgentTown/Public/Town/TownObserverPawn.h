#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "TownObserverPawn.generated.h"

class USpringArmComponent;
class UCameraComponent;

/** Elevated overview camera for town observation. */
UCLASS()
class AGENTTOWN_API ATownObserverPawn : public APawn
{
	GENERATED_BODY()

public:
	ATownObserverPawn();

	virtual void BeginPlay() override;

private:
	UPROPERTY(VisibleAnywhere)
	TObjectPtr<USpringArmComponent> SpringArm;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UCameraComponent> Camera;
};
