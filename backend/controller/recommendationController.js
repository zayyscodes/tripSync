const expressAsyncHandler = require('express-async-handler');
const axios = require('axios');
const Places = require('../models/placesModel');
const UserRatings = require('../models/userRatingsModel');
const Itinerary = require('../models/ItinerariesModel');

const recommendations = expressAsyncHandler(async (req, res) => {
    const userId = req.params.userId;
    const itineraryId = req.query.itineraryId;
    const city = req.query.city;
    const maxPerCategory = parseInt(req.query.maxPerCategory) || 3;

    if (!city || !itineraryId) {
        return res.status(400).json({ error: 'City and itineraryId are required' });
    }

    try {
        // Fetch the itinerary to get places already added
        const itinerary = await Itinerary.findById(itineraryId);
        if (!itinerary) {
            return res.status(404).json({ error: 'Itinerary not found' });
        }
        const itineraryPlaceIds = itinerary.places.map((place) => place.placeId);

        // Dynamically determine user's top categories from ratings
        const ratings = await UserRatings.find({ user_id: userId });
        const categoryScores = {};
        for (const rating of ratings) {
            if (rating.rating >= 4) {
                const place = await Places.findOne({ fsq_id: rating.place_id });
                if (place && place.categories && Array.isArray(place.categories)) {
                    place.categories.forEach(category => {
                        categoryScores[category] = (categoryScores[category] || 0) + rating.rating;
                    });
                }
            }
        }

        // Rank categories by score, take top 3
        let topCategories = Object.entries(categoryScores)
            .sort(([, scoreA], [, scoreB]) => scoreB - scoreA)
            .slice(0, 3)
            .map(([category]) => category);

        // Fallback: If no high ratings, use a neutral set of common categories
        if (!topCategories.length) {
            topCategories = ['Park', 'Restaurant', 'Attraction'];
        }

        // Generalize specific categories to broader Foursquare categories
        const categoryGeneralization = {
            'Steakhouse': 'Restaurant',
            'Cafe, Coffee, and Tea House': 'Cafe',
            'Grocery Store': 'Shopping',
            'Coffee Shop': 'Cafe',
            'Tea Room': 'Cafe',
            'Supermarket': 'Shopping',
            'Food Market': 'Shopping',
            'BBQ Joint': 'Restaurant',
            'Italian Restaurant': 'Restaurant',
            'Mexican Restaurant': 'Restaurant',
            'Seafood Restaurant': 'Restaurant',
            'Bakery': 'Cafe'
        };

        // Map categories to Foursquare category IDs
        const categoryIdMap = {
            'Park': '4bf58dd8d48988d163941735',
            'Cafe': '4bf58dd8d48988d16d941735',
            'Museum': '4bf58dd8d48988d181941735',
            'Restaurant': '4bf58dd8d48988d1c4941735',
            'Attraction': '4bf58dd8d48988d12d951735',
            'Hotel': '4bf58dd8d48988d1fa931735',
            'Music Venue': '4bf58dd8d48988d1e5931735',
            'Shopping': '4bf58dd8d48988d1fd941735',
            'Historic Site': '4deefb944765f83613cdba6e',
            'Nature Preserve': '52e81612bcbc57f1066b7a22',
            'Entertainment': '4bf58dd8d48988d1f1931735'
        };

        // Fetch places from Foursquare for each top category
        const placeDetails = [];
        for (const category of topCategories) {
            const generalizedCategory = categoryGeneralization[category] || category;
            const categoryId = categoryIdMap[generalizedCategory] || categoryIdMap['Attraction'];
            if (!categoryId) {
                console.warn(`No Foursquare category ID for ${generalizedCategory}`);
                continue;
            }
            try {
                // Fetch more places to ensure enough after filtering
                const response = await axios.get(
                    `https://api.foursquare.com/v3/places/search`,
                    {
                        headers: {
                            Authorization: process.env.FOURSQUARE_API
                        },
                        params: {
                            near: city,
                            categories: categoryId,
                            limit: maxPerCategory * 2, // Fetch double to account for filtering
                            sort: 'RATING'
                        }
                    }
                );

                let categoryCount = 0;
                for (const place of response.data.results) {
                    // Skip if place is already in the itinerary
                    if (itineraryPlaceIds.includes(place.fsq_id)) {
                        continue;
                    }
                    if (categoryCount >= maxPerCategory) {
                        break;
                    }

                    let placeData = await Places.findOne({ fsq_id: place.fsq_id });
                    if (!placeData) {
                        placeData = new Places({
                            fsq_id: place.fsq_id,
                            city: place.location?.city || city,
                            name: place.name || 'Unknown',
                            categories: place.categories?.map(cat => cat.name) || [generalizedCategory],
                            address: place.location?.address || 'Unknown',
                            latitude: place.geocodes?.main?.latitude || 0,
                            longitude: place.geocodes?.main?.longitude || 0,
                            reviews: [],
                            photos: place.photos || []
                        });
                        await placeData.save();
                    }
                    placeDetails.push({
                        fsq_id: placeData.fsq_id,
                        name: placeData.name,
                        categories: placeData.categories,
                        city: placeData.city,
                        address: placeData.address,
                        latitude: placeData.latitude,
                        longitude: placeData.longitude,
                        photos: placeData.photos
                    });
                    categoryCount++;
                }
            } catch (error) {
                console.error(`Error fetching places for category ${generalizedCategory}:`, error.message);
                continue;
            }
        }

        if (!placeDetails.length) {
            return res.status(404).json({ error: 'No places found for the given city and categories' });
        }

        res.json(placeDetails);
    } catch (error) {
        console.error('Error generating recommendations:', error.message);
        res.status(500).json({ error: 'Failed to generate recommendations' });
    }
});

module.exports = { recommendations };