#include "Town/TownNpcCharacter.h"
#include "Town/TownNpcAIController.h"
#include "Components/CapsuleComponent.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "Materials/MaterialInstanceDynamic.h"

namespace
{
	static const TCHAR* NpcMeshCandidates[] = {
		TEXT("/Game/Town/Meshes/SKM_Xbot.SKM_Xbot"),
		TEXT("/Game/Town/Meshes/Xbot/Xbot.Xbot"),
		TEXT("/Game/Town/Meshes/Xbot_Skeleton.Xbot_Skeleton"),
	};
}

void ATownNpcCharacter::BeginPlay()
{
	Super::BeginPlay();
	TryAttachNpcMesh();
}

ATownNpcCharacter::ATownNpcCharacter()
{
	AutoPossessAI = EAutoPossessAI::PlacedInWorldOrSpawned;
	AIControllerClass = ATownNpcAIController::StaticClass();

	bUseControllerRotationYaw = false;
	if (UCharacterMovementComponent* Movement = GetCharacterMovement())
	{
		Movement->bOrientRotationToMovement = true;
		Movement->RotationRate = FRotator(0.0f, 540.0f, 0.0f);
		Movement->MaxWalkSpeed = 420.0f;
	}

	BodyMesh = CreateDefaultSubobject<USkeletalMeshComponent>(TEXT("BodyMesh"));
	BodyMesh->SetupAttachment(GetCapsuleComponent());
	BodyMesh->SetRelativeLocation(FVector(0.0f, 0.0f, -88.0f));
	BodyMesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
}

void ATownNpcCharacter::TryAttachNpcMesh()
{
	for (const TCHAR* Path : NpcMeshCandidates)
	{
		USkeletalMesh* LoadedMesh = LoadObject<USkeletalMesh>(nullptr, Path);
		if (!LoadedMesh)
		{
			continue;
		}

		BodyMesh->SetSkeletalMesh(LoadedMesh);
		BodyMesh->SetRelativeScale3D(FVector(1.0f));
		GetCapsuleComponent()->SetHiddenInGame(true);
		UE_LOG(LogTemp, Log, TEXT("TownNpcCharacter: using mesh %s"), Path);
		return;
	}

	UE_LOG(LogTemp, Warning, TEXT("TownNpcCharacter: Xbot mesh not found — run sync-assets.ps1 and import GLB"));
}

void ATownNpcCharacter::ApplyAgentTint(const FLinearColor& Color)
{
	UMaterialInterface* BaseMaterial = LoadObject<UMaterialInterface>(
		nullptr,
		TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	if (!BaseMaterial)
	{
		return;
	}

	UMaterialInstanceDynamic* DynMaterial = UMaterialInstanceDynamic::Create(BaseMaterial, this);
	if (!DynMaterial)
	{
		return;
	}

	DynMaterial->SetVectorParameterValue(TEXT("Color"), Color);

	if (BodyMesh->GetSkeletalMeshAsset())
	{
		BodyMesh->SetMaterial(0, DynMaterial);
	}
	else
	{
		GetCapsuleComponent()->SetMaterial(0, DynMaterial);
	}
}

float ATownNpcCharacter::GetSpawnZOffset()
{
	return 96.0f;
}

FVector ATownNpcCharacter::FeetLocationFromWire(const FVector& WireUePosition)
{
	return WireUePosition + FVector(0.0f, 0.0f, GetSpawnZOffset());
}
