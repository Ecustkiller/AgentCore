#include "Simulation/WireCoordinateTransform.h"

bool FWireVec3::IsFinite() const
{
	return FMath::IsFinite(X) && FMath::IsFinite(Y) && FMath::IsFinite(Z);
}

FVector FWireCoordinateTransform::ToUnreal(const FWireVec3& Wire)
{
	return ToUnreal(Wire.X, Wire.Y, Wire.Z);
}

FVector FWireCoordinateTransform::ToUnreal(double WireX, double WireY, double WireZ)
{
	const float S = static_cast<float>(WorldScale);
	return FVector(
		static_cast<float>(WireX) * S,
		static_cast<float>(-WireZ) * S,
		static_cast<float>(WireY) * S);
}
