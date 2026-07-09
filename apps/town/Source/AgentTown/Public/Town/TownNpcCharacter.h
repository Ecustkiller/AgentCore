#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "TownNpcCharacter.generated.h"

class USkeletalMeshComponent;

/** Xbot (or capsule fallback) character driven by snapshot NavMesh goals. */
UCLASS()
class AGENTTOWN_API ATownNpcCharacter : public ACharacter
{
	GENERATED_BODY()

public:
	ATownNpcCharacter();

	virtual void BeginPlay() override;

	void ApplyAgentTint(const FLinearColor& Color);

	static float GetSpawnZOffset();
	static FVector FeetLocationFromWire(const FVector& WireUePosition);

private:
	void TryAttachNpcMesh();

	UPROPERTY(VisibleAnywhere, Category = "Town")
	TObjectPtr<USkeletalMeshComponent> BodyMesh;
};
